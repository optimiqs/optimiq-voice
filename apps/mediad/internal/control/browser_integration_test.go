package control_test

import (
	"context"
	_ "embed"
	"encoding/json"
	"io"
	"math"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	secure "github.com/optimiqs/optimiq-voice/apps/mediad/internal/webrtc"
	pionrtp "github.com/pion/rtp"
)

//go:embed testdata/webrtc-browser.html
var browserPage string

// This test uses a separate Chromium profile and synthetic audio. No carrier, microphone,
// user database or authenticated session is involved. PLAYWRIGHT_MODULE may point to an
// installed Playwright package; PLAYWRIGHT_BROWSER_PATH optionally selects a browser binary.
func TestChromiumWebRTCAudioAndRecording(t *testing.T) {
	if os.Getenv("RUN_BROWSER_WEBRTC") != "1" {
		t.Skip("set RUN_BROWSER_WEBRTC=1 and install Playwright/Chromium")
	}
	for _, mode := range []string{"browser-originated", "server-originated"} {
		t.Run(mode, func(t *testing.T) { testChromium(t, mode) })
	}
}

func testChromium(t *testing.T, mode string) {
	ctx, cancel := context.WithTimeout(t.Context(), 40*time.Second)
	defer cancel()
	loopback := netip.MustParseAddr("127.0.0.1")
	allocator, err := rtp.NewAllocator(loopback, 37400, 37599)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := rtp.NewManager(rtp.ManagerOptions{Allocator: allocator, PublicAddr: loopback})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Drain(context.Background())
	factory, err := secure.NewFactory(secure.Options{BindIP: loopback, PublicIP: loopback})
	if err != nil {
		t.Fatal(err)
	}
	recordings := t.TempDir()
	server, err := control.NewServer(control.ServerOptions{Sessions: manager, Directory: directory.NewFakeStore(), WebRTC: factory, InstanceID: thisNode, PublicAddr: loopback, RecordingsDir: recordings})
	if err != nil {
		t.Fatal(err)
	}
	phone, err := manager.Allocate(rtp.AllocateOptions{SessionID: "phone", OrgID: testOrg, CallID: testCall})
	if err != nil {
		t.Fatal(err)
	}
	socket, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	var receivedAudio atomic.Uint64
	var recording atomic.Pointer[rtp.Recording]
	go func() {
		buf := make([]byte, 2048)
		for {
			n, _, err := socket.ReadFromUDP(buf)
			if err != nil {
				return
			}
			var packet pionrtp.Packet
			if packet.Unmarshal(buf[:n]) != nil || packet.PayloadType != 0 {
				continue
			}
			for _, sample := range packet.Payload {
				if math.Abs(float64(audio.ULawToLinear(sample))) > 200 {
					receivedAudio.Add(1)
					break
				}
			}
		}
	}()
	go func() {
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		for seq := uint16(0); ; seq++ {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			payload := make([]byte, 160)
			for i := range payload {
				payload[i] = audio.LinearToULaw(int16(6000 * math.Sin(2*math.Pi*440*float64(int(seq)*160+i)/8000)))
			}
			packet := pionrtp.Packet{Header: pionrtp.Header{Version: 2, PayloadType: 0, SequenceNumber: seq, Timestamp: uint32(seq) * 160, SSRC: 3241}, Payload: payload}
			raw, _ := packet.Marshal()
			_, _ = socket.WriteToUDP(raw, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: phone.RTPPort})
		}
	}()
	routes := map[string]func([]byte) []byte{
		"/allocate": server.HandleAllocateSession, "/offer": server.HandleCreateOffer, "/answer": server.HandleAcceptAnswer,
		"/bridge": server.HandleBridgeSessions, "/record": server.HandleStartRecording, "/stop-record": server.HandleStopRecording,
		"/release": server.HandleReleaseSession,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = io.WriteString(w, browserPage)
	})
	mux.HandleFunc("GET /stats", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]uint64{"receivedAudio": receivedAudio.Load()})
	})
	for path, handler := range routes {
		mux.HandleFunc("POST "+path, func(w http.ResponseWriter, r *http.Request) {
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128*1024))
			if err != nil {
				http.Error(w, "invalid request", 400)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			reply := handler(body)
			if path == "/record" {
				if session, ok := manager.Get("browser"); ok {
					recording.Store(session.ActiveRecording())
				}
			}
			_, _ = w.Write(reply)
		})
	}
	httpServer := httptest.NewServer(mux)
	defer httpServer.Close()
	script := `const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_BROWSER_PATH || undefined,args:['--autoplay-policy=no-user-gesture-required']});
try{const page=await browser.newPage(); await page.goto(process.argv[1]); await page.waitForFunction(()=>window.result!==undefined,{},{timeout:25000}); const result=await page.evaluate(()=>window.result); console.log(JSON.stringify(result)); if(!result.ok)process.exitCode=1;}finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exitCode=1;});`
	command := exec.CommandContext(ctx, "node", "-e", script, httpServer.URL+"/?mode="+mode)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Chromium verification failed: %v\n%s", err, output)
	}
	t.Logf("Chromium: %s", output)
	active := recording.Load()
	if active == nil {
		t.Fatal("browser did not start a recording")
	}
	select {
	case <-active.Done():
	case <-ctx.Done():
		t.Fatal("recording did not finish")
	}
	if active.Dropped() != 0 || active.Summary().Reason == rtp.RecordingError {
		t.Fatalf("recording lost audio: dropped=%d summary=%+v", active.Dropped(), active.Summary())
	}
	recordingPath := filepath.Join(recordings, testOrg, testCall, "browser-record.wav")
	for range 30 {
		if info, err := os.Stat(recordingPath); err == nil && info.Size() > 8044 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("browser conversation recording was not finalized with audio")
}
