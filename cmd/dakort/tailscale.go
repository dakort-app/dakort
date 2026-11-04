package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os/exec"
	"strings"
	"time"
)

// Where the tailscale command lives when it is not on PATH: a service
// gets a bare PATH, and the Mac App Store build keeps its command inside
// the app.
var tailscalePlaces = []string{
	`C:\Program Files\Tailscale\tailscale.exe`,
	"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
	"/usr/local/bin/tailscale",
	"/opt/homebrew/bin/tailscale",
	"/usr/bin/tailscale",
}

// errNoTailscale means the machine has no tailscale command: nothing to
// wait for.
var errNoTailscale = errors.New("no tailscale command")

func tailscaleBin() (string, error) {
	if p, err := exec.LookPath("tailscale"); err == nil {
		return p, nil
	}
	for _, p := range tailscalePlaces {
		if _, err := exec.LookPath(p); err == nil {
			return p, nil
		}
	}
	return "", errNoTailscale
}

// tailscaleSelf asks `tailscale status --json` for this machine's tailnet
// name (Self.DNSName, without the final dot) and addresses. An error, or
// no addresses, while Tailscale is installed but not up (after boot,
// signed out, switched off).
func tailscaleSelf(bin string) (name string, ips []net.IP, err error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "status", "--json").Output()
	if err != nil {
		return "", nil, err
	}
	var st struct {
		BackendState string `json:"BackendState"`
		Self         struct {
			DNSName      string   `json:"DNSName"`
			TailscaleIPs []string `json:"TailscaleIPs"`
		} `json:"Self"`
	}
	if err := json.Unmarshal(out, &st); err != nil {
		return "", nil, err
	}
	if st.BackendState != "Running" {
		return "", nil, errors.New("tailscale is " + strings.ToLower(st.BackendState))
	}
	for _, s := range st.Self.TailscaleIPs {
		if ip := net.ParseIP(s); ip != nil && isTailscaleIP(ip) {
			ips = append(ips, ip)
		}
	}
	return strings.TrimSuffix(st.Self.DNSName, "."), ips, nil
}

// Tailscale hands out addresses from these ranges only (CGNAT for IPv4,
// its own ULA prefix for IPv6).
var tailscaleNets = []*net.IPNet{
	{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)},
	{IP: net.ParseIP("fd7a:115c:a1e0::"), Mask: net.CIDRMask(48, 128)},
}

func isTailscaleIP(ip net.IP) bool {
	for _, n := range tailscaleNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}
