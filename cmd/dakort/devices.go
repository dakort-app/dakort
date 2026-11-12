package main

import (
	"context"
	"encoding/json"
	"net"
	"os/exec"
	"strings"
	"time"

	"github.com/dakort-app/dakort/internal/server"
)

// devices tells the server where a phone or another computer reaches it,
// for the Other devices panel: Tailscale Serve's HTTPS address when one
// proxies to this port, this machine's tailnet name (its addresses when
// it has none), and the -expose addresses. Asked each time the panel
// opens, so it says what is true now.
func devices(port string, exposed []string) func() server.Devices {
	return func() server.Devices {
		d := server.Devices{LocalURL: "http://127.0.0.1:" + port + "/"}
		bin, err := tailscaleBin()
		if err != nil {
			d.Tailscale = "none"
		} else if name, ips, err := tailscaleSelf(bin); err != nil || len(ips) == 0 {
			d.Tailscale = "down"
			if err != nil {
				d.Why = err.Error()
			}
		} else {
			d.Tailscale = "up"
			for _, u := range serveURLs(bin, port) {
				d.Addrs = append(d.Addrs, server.DeviceAddr{URL: u, Kind: "https"})
			}
			if name != "" {
				d.Addrs = append(d.Addrs, server.DeviceAddr{URL: "http://" + net.JoinHostPort(name, port) + "/", Kind: "tailnet"})
			} else {
				for _, ip := range ips {
					d.Addrs = append(d.Addrs, server.DeviceAddr{URL: "http://" + net.JoinHostPort(ip.String(), port) + "/", Kind: "tailnet"})
				}
			}
		}
		for _, a := range exposed {
			for _, h := range exposedHosts(a) {
				d.Addrs = append(d.Addrs, server.DeviceAddr{URL: "http://" + h + "/", Kind: "exposed"})
			}
		}
		return d
	}
}

// serveURLs asks `tailscale serve status --json` which HTTPS addresses
// proxy to this machine's port (dakort setup -https made one). None on
// any error: Serve is the exception, and the plain address is listed
// anyway.
func serveURLs(bin, port string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, bin, "serve", "status", "--json").Output()
	if err != nil {
		return nil
	}
	var st struct {
		Web map[string]struct {
			Handlers map[string]struct {
				Proxy string `json:"Proxy"`
			} `json:"Handlers"`
		} `json:"Web"`
	}
	if err := json.Unmarshal(out, &st); err != nil {
		return nil
	}
	var urls []string
	for hostport, w := range st.Web {
		h, ok := w.Handlers["/"]
		if !ok || !strings.HasSuffix(h.Proxy, ":"+port) {
			continue
		}
		if host, p, err := net.SplitHostPort(hostport); err == nil && p == "443" {
			hostport = host
		}
		urls = append(urls, "https://"+hostport+"/")
	}
	return urls
}

// exposedHosts turns an -expose address into the host:port pairs a device
// can open: itself, or, for every interface (an empty host, 0.0.0.0), each
// of this machine's non-loopback IPv4 addresses.
func exposedHosts(addr string) []string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return []string{addr}
	}
	ip := net.ParseIP(host)
	if host != "" && (ip == nil || !ip.IsUnspecified()) {
		return []string{addr}
	}
	var out []string
	ifaddrs, _ := net.InterfaceAddrs()
	for _, a := range ifaddrs {
		n, ok := a.(*net.IPNet)
		if !ok || n.IP.IsLoopback() || n.IP.To4() == nil || isTailscaleIP(n.IP) {
			continue
		}
		out = append(out, net.JoinHostPort(n.IP.String(), port))
	}
	return out
}
