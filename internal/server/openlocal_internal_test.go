package server

import (
	"net"
	"net/http/httptest"
	"testing"
)

// A browser on this computer counts as local, straight or through
// Tailscale Serve from one of its own addresses; a phone through Serve,
// a forged X-Forwarded-For entry before Serve's, or a request from
// elsewhere does not.
func TestOnThisMachine(t *testing.T) {
	var own string
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil {
				own = n.IP.String()
				break
			}
		}
	}
	req := func(host, remote, xff string) bool {
		r := httptest.NewRequest("GET", "http://"+host+"/api/here", nil)
		r.RemoteAddr = remote
		if xff != "" {
			r.Header.Set("X-Forwarded-For", xff)
		}
		return onThisMachine(r)
	}
	if !req("127.0.0.1:3002", "127.0.0.1:5000", "") {
		t.Error("a direct request from this computer")
	}
	if req("laptop.example.ts.net", "127.0.0.1:5000", "203.0.113.9") {
		t.Error("a phone through Serve counted as local")
	}
	if req("laptop.example.ts.net", "127.0.0.1:5000", "127.0.0.1, 203.0.113.9") {
		t.Error("a forged first X-Forwarded-For entry counted")
	}
	if req("laptop.example.ts.net", "203.0.113.9:5000", "127.0.0.1") {
		t.Error("X-Forwarded-For from a peer that is not Serve counted")
	}
	if own != "" && !req("laptop.example.ts.net", "127.0.0.1:5000", own) {
		t.Errorf("this computer through Serve (%s) did not count", own)
	}
}
