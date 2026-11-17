package agent

import (
	"encoding/json"
	"testing"
)

func TestCodexSignedOut(t *testing.T) {
	cases := []struct {
		info, msg string
		want      bool
	}{
		// The live turn/completed and the rollout's task_complete (2026-11-17).
		{`{"httpConnectionFailed":{"httpStatusCode":401}}`, "unexpected status 401 Unauthorized: Missing bearer", true},
		{`{"http_connection_failed":{"http_status_code":401}}`, "x", true},
		{`{"responseStreamDisconnected":{"httpStatusCode":401}}`, "Reconnecting... 2/5", true},
		{`"unauthorized"`, "x", true},
		// No info, the words only (a refresh that failed; not seen on the wire).
		{``, "Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.", true},
		{`null`, "unexpected status 401 Unauthorized", true},
		// Not a login.
		{`"usageLimitExceeded"`, "You've hit your usage limit.", false},
		{`{"httpConnectionFailed":{"httpStatusCode":503}}`, "unexpected status 503 Service Unavailable", false},
		{`{"httpConnectionFailed":{"httpStatusCode":null}}`, "stream disconnected", false},
	}
	for _, c := range cases {
		if got := CodexSignedOut(json.RawMessage(c.info), c.msg); got != c.want {
			t.Errorf("%s %q: %v, want %v", c.info, c.msg, got, c.want)
		}
	}
}
