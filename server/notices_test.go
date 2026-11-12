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
