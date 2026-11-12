package server

import (
	"fmt"
	"net/http"
	"strings"

	"rsc.io/qr"
)

// The "Other devices" panel (the icon beside the moon): where this
// computer can be reached from a phone or another computer, and the
// password those devices log in with. Nobody has to read the terminal:
// the first tap on the computer itself asks for a password, every later
// one shows the address and a QR code. The addresses come from the
// program that runs the server (cmd/dakort asks Tailscale), and are
// asked for each time the panel opens, so Tailscale going off or coming
// on shows at once.
//
//	GET  /api/devices          the addresses, the Tailscale state, whether a password is set
//	GET  /api/devices/qr?url=  one of those addresses as a QR code (SVG)
//	POST /api/password         {password}: choose it, or change it (any logged-in device)

// Devices is what the program running the server knows about reaching it.
type Devices struct {
	// Tailscale is "up", "down" (installed but not running, or signed
	// out) or "none" (not installed).
	Tailscale string       `json:"tailscale"`
	Why       string       `json:"why,omitempty"` // down: what Tailscale said
	Addrs     []DeviceAddr `json:"addrs"`
	LocalURL  string       `json:"localUrl,omitempty"` // this computer's own address, where the password is chosen
}

// DeviceAddr is one address another device can open.
type DeviceAddr struct {
	URL string `json:"url"`
	// Kind is "tailnet", "https" (through Tailscale Serve) or "exposed"
	// (-expose: beyond the tailnet, the password the only guard).
	Kind string `json:"kind"`
}

type devicesState struct {
	Devices
	PasswordSet bool `json:"passwordSet"`
	Local       bool `json:"local"` // the request came straight to this computer's loopback address
}

func (s *Server) devicesState(w http.ResponseWriter, r *http.Request) {
	st := devicesState{Devices: Devices{Tailscale: "none"}, PasswordSet: s.pw.isSet(), Local: direct(r)}
	if s.devices != nil {
		st.Devices = s.devices()
	}
	if st.Addrs == nil {
		st.Addrs = []DeviceAddr{}
	}
	if st.LocalURL == "" {
		st.LocalURL = "http://127.0.0.1" + portOf(r) + "/"
	}
	writeJSON(w, st)
}

// devicesQR draws one of the current addresses, and nothing else, as a
// QR code.
func (s *Server) devicesQR(w http.ResponseWriter, r *http.Request) {
	url := r.URL.Query().Get("url")
	known := false
	if s.devices != nil {
		for _, a := range s.devices().Addrs {
			known = known || a.URL == url
		}
	}
	if !known {
		http.Error(w, "not one of this computer's addresses", http.StatusNotFound)
		return
	}
	svg, err := qrSVG(url)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(svg)
}

// qrSVG is the text as a QR code, one path of unit squares on white, with
// the four-module quiet zone scanners want.
func qrSVG(text string) ([]byte, error) {
	c, err := qr.Encode(text, qr.M)
	if err != nil {
		return nil, err
	}
	const quiet = 4
	n := c.Size + 2*quiet
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges"><rect width="%d" height="%d" fill="#fff"/><path fill="#000" d="`, n, n, n, n)
	for y := 0; y < c.Size; y++ {
		for x := 0; x < c.Size; x++ {
			if c.Black(x, y) {
				fmt.Fprintf(&b, "M%d %dh1v1h-1z", x+quiet, y+quiet)
			}
		}
	}
	b.WriteString(`"/></svg>`)
	return []byte(b.String()), nil
}

// passwordChange chooses the password, or replaces it, from any device
// that is logged in (this route is behind the cookie, unlike the login
// page's /api/setup, which is why that one is loopback-only). No old
// password is asked: being logged in is the proof, and a logged-in
// device can already run commands as the user. The laptop's own browser
// usually opens the tailnet address, so a loopback-only rule hid the
// link from the person it was for. Devices already logged in stay logged
// in; their cookie holds the token, not the password.
func (s *Server) passwordChange(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Password string `json:"password"`
	}
	if !readJSON(w, r, &req) {
		return
	}
	switch {
	case len([]rune(req.Password)) < minPassword:
		s.reply(w, http.StatusOK)(nil, &httpError{status: 400, msg: "use at least 8 characters"})
	default:
		if err := s.pw.set(req.Password); err != nil {
			s.reply(w, http.StatusOK)(nil, err)
			return
		}
		writeJSON(w, struct{}{})
	}
}
