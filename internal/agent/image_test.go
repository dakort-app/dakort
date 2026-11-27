package agent

import (
	"encoding/json"
	"testing"
)

// An image goes back to the browser (a queued message taken back to edit)
// under the names the browser sent it with: as MediaType and Data the
// edit lost its images and the page read data.length of undefined.
func TestImageJSONNames(t *testing.T) {
	out, err := json.Marshal(Image{MediaType: "image/png", Data: []byte{1}})
	if err != nil || string(out) != `{"mediaType":"image/png","data":"AQ=="}` {
		t.Fatalf("got %s, %v", out, err)
	}
	var back Image
	if err := json.Unmarshal(out, &back); err != nil || back.MediaType != "image/png" || len(back.Data) != 1 {
		t.Fatalf("round trip: %+v, %v", back, err)
	}
}
