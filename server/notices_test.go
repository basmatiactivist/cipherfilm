package main

import (
	"testing"
	"time"
)

// Notices are kept at most noticesAge: the janitor prunes every account's old ones, also of an account that gets no
// new notice, and none older is shown even before it ran.
func TestOldNoticesAreDroppedWithoutANewOne(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, _ := e.setupAdmin("admin@x.org")
	bob, _ := e.acceptInvite(e.invite(admin, "bob@x.org"))
	ub, _ := e.app.userByEmail("bob@x.org")
	e.app.notify(ub.ID, noticeTwoFactorReset, "", "")
	if k := shownKinds(t, bob); len(k) != 1 {
		t.Fatalf("shown: %v", k)
	}
	clk.tick(noticesAge + time.Hour)
	e.app.db.Exec(`UPDATE sessions SET last_seen=?, expires_at=?`, clk.at.Unix(), clk.at.Add(sessionIdle).Unix())
	if k := shownKinds(t, bob); len(k) != 0 {
		t.Fatalf("older than %v still shown: %v", noticesAge, k)
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM notices WHERE user_id=?`, ub.ID).Scan(&n)
	if n != 1 {
		t.Fatalf("%d stored before the janitor ran", n)
	}
	e.app.pruneNotices()
	e.app.db.QueryRow(`SELECT COUNT(*) FROM notices WHERE user_id=?`, ub.ID).Scan(&n)
	if n != 0 {
		t.Fatalf("%d left after the janitor", n)
	}
}

// Someone who has the password but no code repeats the password step every 4 minutes for 5 hours: the notice about
// it is shown pendingTTL after the first step, not postponed by the later ones, and there is at most one an hour.
func TestRepeatedPasswordStepsDontHideTheNotice(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	e.enable2FA(admin, ab)
	clk.tick(30 * time.Second)
	u, _ := e.app.userByEmail("admin@x.org")
	shown := func() (n int) {
		e.app.db.Exec(`UPDATE sessions SET last_seen=?, expires_at=?`, clk.at.Unix(), clk.at.Add(sessionIdle).Unix())
		for _, k := range shownKinds(t, admin) {
			if k == noticePasswordUsed {
				n++
			}
		}
		return
	}
	start := clk.at
	firstShown := time.Duration(-1)
	for clk.at.Sub(start) < 5*time.Hour {
		e.passwordStep(e.client(), "admin@x.org", ab)
		for i := 0; i < 4; i++ {
			clk.tick(time.Minute)
			if firstShown < 0 && shown() > 0 {
				firstShown = clk.at.Sub(start)
			}
		}
	}
	if firstShown < 0 || firstShown > pendingTTL+time.Minute {
		t.Fatalf("first shown after %v, want at most %v", firstShown, pendingTTL+time.Minute)
	}
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM notices WHERE user_id=? AND kind=?`, u.ID, noticePasswordUsed).Scan(&n)
	if n < 4 || n > 6 {
		t.Fatalf("%d notices in 5 hours, want one an hour", n)
	}
}

// Changes to two-step sign-in made on one device are shown on the account's other devices that were signed in then:
// not on the device that made them, and not on one that signs in afterwards.
func TestTwoFactorChangesAreNoticedElsewhere(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab := e.setupAdmin("admin@x.org")
	other := e.login("admin@x.org", ab)
	dismissAll := func(c *client) {
		_, out := c.do("GET", "/api/me/notices", nil, false)
		for _, n := range out["notices"].([]any) {
			c.do("POST", "/api/me/notices/"+itoa(int64(n.(map[string]any)["id"].(float64)))+"/dismiss", nil, true)
		}
	}
	dismissAll(admin)
	expect := func(kind string) {
		t.Helper()
		if k := shownKinds(t, other); len(k) != 1 || k[0] != kind {
			t.Fatalf("other device: %v, want [%s]", k, kind)
		}
		if k := shownKinds(t, admin); len(k) != 0 {
			t.Fatalf("the device that made the change: %v", k)
		}
		dismissAll(other)
	}
	secret, codes := e.enable2FA(admin, ab)
	expect(noticeTOTPAdded)
	clk.tick(30 * time.Second)
	if code, _ := admin.do("POST", "/api/me/2fa/recovery-codes", map[string]any{"current_auth": ab["auth"], "code": codeAt(t, secret, clk.at)}, true); code != 200 {
		t.Fatal(code)
	}
	expect(noticeRecoveryCodes)
	clk.tick(time.Second)
	if code, _ := admin.do("POST", "/api/me/2fa/disable", map[string]any{"current_auth": ab["auth"], "code": codes[0]}, true); code == 200 {
		t.Fatal("an old recovery code worked")
	}
	clk.tick(30 * time.Second)
	if code, _ := admin.do("POST", "/api/me/2fa/disable", map[string]any{"current_auth": ab["auth"], "code": codeAt(t, secret, clk.at)}, true); code != 200 {
		t.Fatal(code)
	}
	// a device signed in after a change isn't shown it
	clk.tick(time.Second)
	if k := shownKinds(t, e.login("admin@x.org", ab)); len(k) != 0 {
		t.Fatalf("later device: %v", k)
	}
	if k := shownKinds(t, other); len(k) != 2 || k[1] != noticeTwoFactorOff {
		t.Fatalf("other device: %v", k)
	}
}

// Passkeys added or removed are noticed the same way; removing the last one turns two-step sign-in off.
func TestPasskeyChangesAreNoticedElsewhere(t *testing.T) {
	e := newEnv(t)
	clk := e.pinClock()
	admin, ab, k, codes := e.adminWithPasskey()
	clk.tick(time.Second)
	other := e.hostClient()
	p := e.passwordStep(other, "admin@x.org", ab)
	if r := other.post("/api/auth/login/2fa", map[string]any{"pending": p, "code": codes[0]}); r.code != 200 {
		t.Fatalf("second device: %d %v", r.code, r.body)
	}
	k2 := newSoftKey(t)
	e.addPasskey(admin, ab, k2, "passkey", e.proofPasskey(admin, k))
	if got := shownKinds(t, other); len(got) != 1 || got[0] != noticePasskeyAdded {
		t.Fatalf("added: %v", got)
	}
	_, l := admin.do("GET", "/api/me/passkeys", nil, false)
	ids := []string{}
	for _, x := range l["passkeys"].([]any) {
		ids = append(ids, x.(map[string]any)["id"].(string))
	}
	if code, out := admin.do("DELETE", "/api/me/passkeys/"+ids[0], map[string]any{"current_auth": ab["auth"], "code": codes[1]}, true); code != 200 {
		t.Fatalf("delete: %d %v", code, out)
	}
	if code, out := admin.do("DELETE", "/api/me/passkeys/"+ids[1], map[string]any{"current_auth": ab["auth"], "code": codes[2]}, true); code != 200 || out["two_factor"] != false {
		t.Fatalf("delete the last: %d %v", code, out)
	}
	got := shownKinds(t, other)
	if len(got) != 3 || got[0] != noticeTwoFactorOff || got[1] != noticePasskeyRemoved {
		t.Fatalf("removed: %v", got)
	}
	if got := shownKinds(t, admin); len(got) != 1 || got[0] != noticeSignIn { // only the other device's sign-in
		t.Fatalf("on the device that made them: %v", got)
	}
}

// An administrator's reset asks the person to turn two-step sign-in on again; once they do, the notice is gone on
// every device.
func TestResetNoticeGoesWhenTwoStepIsBackOn(t *testing.T) {
	e := newEnv(t)
	e.pinClock()
	admin, _ := e.setupAdmin("admin@x.org")
	bob, bb := e.acceptInvite(e.invite(admin, "bob@x.org"))
	other := e.login("bob@x.org", bb)
	ub, _ := e.app.userByEmail("bob@x.org")
	e.app.notify(ub.ID, noticeTwoFactorReset, "", "")
	if k := shownKinds(t, other); len(k) != 1 || k[0] != noticeTwoFactorReset {
		t.Fatalf("before: %v", k)
	}
	e.enable2FA(bob, bb)
	for _, c := range []*client{bob, other} {
		for _, k := range shownKinds(t, c) {
			if k == noticeTwoFactorReset {
				t.Fatalf("the reset notice is still shown: %v", shownKinds(t, c))
			}
		}
	}
}
