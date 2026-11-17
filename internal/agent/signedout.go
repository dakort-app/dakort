package agent

import (
	"encoding/json"
	"strings"
)

// CodexSignedOut tells whether a failed Codex turn failed for want of a
// login, from its error: the live turn/completed (codexErrorInfo, camel
// case) and the rollout's task_complete (codex_error_info, snake case)
// carry the same thing. Shared by the relay and the transcript reader, so
// the page offers the sign-in both live and after a reload.
//
// Measured 2026-11-17, codex 0.163.0, an empty CODEX_HOME: the info is
// {"httpConnectionFailed":{"httpStatusCode":401}} (after retries whose
// info is responseStreamDisconnected with the same 401). The binary also
// has a bare "unauthorized" kind, taken as the same. The words are the
// fallback: the 401's, and those of a login whose refresh failed ("Your
// access token could not be refreshed... Please sign in again"), which
// were not seen on the wire.
func CodexSignedOut(info json.RawMessage, message string) bool {
	var kind string
	if json.Unmarshal(info, &kind) == nil && kind == "unauthorized" {
		return true
	}
	var kinds map[string]struct {
		Camel *int `json:"httpStatusCode"`
		Snake *int `json:"http_status_code"`
	}
	if json.Unmarshal(info, &kinds) == nil {
		for _, k := range kinds {
			if k.Camel != nil && *k.Camel == 401 || k.Snake != nil && *k.Snake == 401 {
				return true
			}
		}
	}
	m := strings.ToLower(message)
	for _, w := range []string{"401 unauthorized", "access token could not be refreshed", "sign in again", "codex login again"} {
		if strings.Contains(m, w) {
			return true
		}
	}
	return false
}
