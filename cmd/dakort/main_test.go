package main

import (
	"net"
	"testing"
)

// -addr takes loopback and Tailscale addresses only; everything else,
// every interface above all, needs -expose.
func TestPrivate(t *testing.T) {
	for addr, ok := range map[string]bool{
		"127.0.0.1:3002":        true,
		"localhost:3002":        true,
		"[::1]:3002":            true,
		"100.82.13.81:3002":     true,
		"[fd7a:115c:a1e0::1]:1": true,
		":3002":                 false,
		"0.0.0.0:3002":          false,
		"[::]:3002":             false,
		"192.168.1.20:3002":     false,
		"100.128.0.1:3002":      false, // just past Tailscale's range
		"3002":                  false,
	} {
		if err := private(addr); (err == nil) != ok {
			t.Errorf("private(%q) = %v, want ok=%v", addr, err, ok)
		}
	}
}

// On a machine with Tailscale up (this laptop), the status names the
// machine and gives at least one tailnet address.
func TestRealTailscaleSelf(t *testing.T) {
	bin, err := tailscaleBin()
	if err != nil {
		t.Skip("no tailscale here")
	}
	name, ips, err := tailscaleSelf(bin)
	if err != nil {
		t.Skipf("tailscale not up: %v", err)
	}
	if name == "" || name[len(name)-1] == '.' {
		t.Errorf("name %q, want the tailnet name without the final dot", name)
	}
	if len(ips) == 0 {
		t.Fatal("no tailnet address")
	}
	for _, ip := range ips {
		if !isTailscaleIP(ip) || ip.Equal(net.IPv4zero) {
			t.Errorf("address %v is not a tailnet one", ip)
		}
	}
	t.Logf("%s %v", name, ips)
}
