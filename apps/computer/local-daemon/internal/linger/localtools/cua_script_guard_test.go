package localtools

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// guardHarness runs a guarded script in node against a fake cua that logs
// what reaches it. The driver runs scripts in its own JS engine; node checks
// the same prelude's semantics.
const guardHarness = `import fs from "fs";
const log = [];
class App { constructor(n) { this.n = n; } click(a) { log.push("raw:" + JSON.stringify(a)); return "clicked"; } }
const fake = { call(t, a) { log.push("call:" + t + ":" + JSON.stringify(a)); return Promise.resolve({ok: true}); },
  getApp() { return Promise.resolve(new App("a")); },
  listApps() { return Promise.resolve([new App("b")]); },
  box() { return Promise.resolve({inner: {app: new App("c")}}); },
  sleep(ms) { log.push("sleep:" + (ms >= 400 && ms < 1300 ? "paced" : ms)); return Promise.resolve(); } };
Object.defineProperty(globalThis, "cua", {value: Object.freeze(fake), writable: false, configurable: false});
const AsyncFunction = (async function () {}).constructor;
let result;
try { result = await new AsyncFunction(fs.readFileSync(process.argv[2], "utf8"))(); } catch (e) { result = "threw:" + e.message; }
console.log(JSON.stringify({result, log}));
`

func TestScriptGuardRefusesForbiddenInputInAJSEngine(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	dir := t.TempDir()
	harness := filepath.Join(dir, "harness.mjs")
	if err := os.WriteFile(harness, []byte(guardHarness), 0o600); err != nil {
		t.Fatal(err)
	}
	cases := []struct{ name, body, want, notLogged string }{
		{"background call passes", `return await cua.call("click", {pid: 1});`, `call:click:{\"pid\":1}`, ""},
		{"top-level key", `return await cua.call("click", {delivery_mode: "foreground"});`, "threw:COMPUTER_SCRIPT_REFUSED", "call:"},
		{"computed nested key", `return await cua.call("click", {a: [{["deliv" + "ery_mode"]: "x"}]});`, "threw:COMPUTER_SCRIPT_REFUSED", "call:"},
		{"toJSON", `return await cua.call("click", {toJSON() { return {delivery_mode: "foreground"}; }});`, "threw:COMPUTER_SCRIPT_REFUSED", "call:"},
		{"app method", `const app = await cua.getApp({pid: 1}); return app.click({delivery_mode: "foreground"});`, "threw:COMPUTER_SCRIPT_REFUSED", "raw:"},
		{"handle in an array", `const apps = await cua.listApps(); return apps[0].click({delivery_mode: "foreground"});`, "threw:COMPUTER_SCRIPT_REFUSED", "raw:"},
		{"handle in an object", `const b = await cua.box(); return b.inner.app.click({out_file: "/tmp/x"});`, "threw:COMPUTER_SCRIPT_REFUSED", "raw:"},
		{"no global object", `return [typeof globalThis, typeof eval, typeof Function, typeof this].join(",");`, "undefined,undefined,undefined,undefined", ""},
		{"no function constructor", `return typeof (async function () {}).constructor;`, "undefined", ""},
		{"closing the wrapper", "return 1; }).call(undefined); })(globalThis.cua, globalThis, eval, Function); (function () { return (async function () {", "threw:COMPUTER_SCRIPT_REFUSED: the script is not one complete function body", "call:"},
		{"closing the wrapper to call", `}); await globalThis.cua.call("click", {["deliv" + "ery_mode"]: "foreground"}); (async function () {`, "threw:", "call:"},
		{"inputs", `return [args.n, DEADLINE].join(",");`, `"1,42"`, ""},
		{"frozen builtins", `try { JSON.parse = () => ({delivery_mode: 1}); } catch (e) { return "refused"; } return "changed";`, "refused", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			script := filepath.Join(dir, "script.js")
			if err := os.WriteFile(script, []byte(guardedScript(`{"n":1}`, tc.body, 42, 0)), 0o600); err != nil {
				t.Fatal(err)
			}
			out, err := exec.Command(node, harness, script).CombinedOutput()
			if err != nil {
				t.Fatalf("node: %v\n%s", err, out)
			}
			got := string(out)
			if !strings.Contains(got, tc.want) || tc.notLogged != "" && strings.Contains(got, `"`+tc.notLogged) {
				t.Fatalf("got %s, want %q without %q reaching the driver", got, tc.want, tc.notLogged)
			}
		})
	}
}

// A paced script waits before each input and stops at its input limit, and
// the inputs past it never reach the driver.
func TestScriptGuardPacesInputsForTheComputersChrome(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	dir := t.TempDir()
	harness := filepath.Join(dir, "harness.mjs")
	script := filepath.Join(dir, "script.js")
	body := `await cua.call("click", {pid: 1}); await cua.call("get_window_state", {pid: 1}); const app = await cua.getApp({pid: 1}); app.click({pid: 1}); await cua.call("press_key", {pid: 1}); return "done";`
	if err := os.WriteFile(harness, []byte(guardHarness), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte(guardedScript(`{}`, body, 42, 2)), 0o600); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(node, harness, script).CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, out)
	}
	got := string(out)
	if !strings.Contains(got, "threw:COMPUTER_SCRIPT_INPUT_LIMIT") || strings.Count(got, "sleep:paced") != 2 || strings.Contains(got, "press_key") || !strings.Contains(got, "call:get_window_state") {
		t.Fatalf("got %s", got)
	}
}

// A paced script opens no app or URL, so launch_app's site checks hold; an
// unpaced script may still call it.
func TestScriptGuardRefusesLaunchAppForTheComputersChrome(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	dir := t.TempDir()
	harness := filepath.Join(dir, "harness.mjs")
	if err := os.WriteFile(harness, []byte(guardHarness), 0o600); err != nil {
		t.Fatal(err)
	}
	body := `return await cua.call("launch_app", {urls: ["https://example.com/"]});`
	for _, tc := range []struct {
		limit int
		want  string
	}{{2, "threw:COMPUTER_SCRIPT_REFUSED"}, {0, "call:launch_app"}} {
		script := filepath.Join(dir, "script.js")
		if err := os.WriteFile(script, []byte(guardedScript(`{}`, body, 42, tc.limit)), 0o600); err != nil {
			t.Fatal(err)
		}
		out, err := exec.Command(node, harness, script).CombinedOutput()
		if err != nil {
			t.Fatalf("node: %v\n%s", err, out)
		}
		if got := string(out); !strings.Contains(got, tc.want) || tc.limit > 0 && strings.Contains(got, "call:launch_app") {
			t.Fatalf("limit %d: got %s, want %q", tc.limit, got, tc.want)
		}
	}
}
