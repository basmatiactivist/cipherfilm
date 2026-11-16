package main

import "testing"

// However many entries people write about their own devices, the next administrative entry keeps the earlier
// administrative ones: each part of the log keeps its own newest rows, counted in rows, not ids.
func TestOwnEntriesNeverTrimTheAdminPart(t *testing.T) {
	e := newEnv(t)
	admin, _ := e.setupAdmin("admin@x.org")
	e.acceptInvite(e.invite(admin, "bob@x.org"))
	e.invite(admin, "carla@x.org")
	for i := 0; i < auditKeep+20; i++ {
		e.app.audit("bob@x.org", "signed out a device", "bob@x.org", "phone")
	}
	e.invite(admin, "eve@x.org")
	var n int
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE actor='admin@x.org' AND action='invited'`).Scan(&n)
	if n != 3 {
		t.Fatalf("admin invites kept after the own entries: %d, want 3", n)
	}
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE ` + selfService).Scan(&n)
	if n != auditKeep {
		t.Fatalf("own entries kept: %d, want %d", n, auditKeep)
	}
	// the admin part is trimmed by its own count
	for i := 0; i < auditKeep+5; i++ {
		e.app.audit("admin@x.org", "changed a setting", "", "")
	}
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE NOT ` + selfService).Scan(&n)
	if n != auditKeep {
		t.Fatalf("admin entries kept: %d, want %d", n, auditKeep)
	}
	e.app.db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE ` + selfService).Scan(&n)
	if n != auditKeep {
		t.Fatalf("own entries after admin burst: %d, want %d", n, auditKeep)
	}
}
