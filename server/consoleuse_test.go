package main

import (
	"os"
	"testing"
)

// Control characters (C1 ones too, which net/mail lets through) never make it into an account's address: the
// server commands print addresses raw in an operator's terminal.
func TestEmailWithControlCharactersIsRefused(t *testing.T) {
	for _, in := range []string{"a\u009b2K@x.org", "a\u009d0;x\u0007@x.org", "a\u0085b@x.org", "a‎b@x.org"} {
		if e, ok := normEmail(in); ok {
			t.Errorf("normEmail(%q) accepted: %q", in, e)
		}
	}
	if e, ok := normEmail("Anna.Müller@Example.org"); !ok || e != "anna.müller@example.org" {
		t.Fatalf("a normal address: %q %v", e, ok)
	}
}

// As root on data another user owns, the commands refuse; on root's own data (a server run as root) they go ahead.
func TestCommandsRefuseRootOnTheServersData(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root (the CI container runs the tests as root)")
	}
	d := t.TempDir()
	if err := notRootOnTheirData(d); err != nil {
		t.Fatalf("root's own data: %v", err)
	}
	if err := os.Chown(d, 65532, 65532); err != nil {
		t.Fatal(err)
	}
	if err := notRootOnTheirData(d); err == nil {
		t.Fatal("root on the server user's data was allowed")
	}
}
