package localtools

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
)

// macScriptDescription replaces Cua's run_script description with the
// Computer's rules: background input only, and a bounded result.
const macScriptDescription = "Run a JavaScript program that drives apps on this Mac in ONE call: loops, waits, reads and checks between inputs, and only its return value comes back. Use it to repeat a flow over several items, such as open each result, read it and close it, instead of one model turn per input. The script is the body of an async function: use await and return a JSON value. The only API is cua:\n" +
	"- const app = await cua.getApp({pid, windowId}) or cua.getApp(\"Google Chrome\"); cua.sleep(ms), where ms must be a whole number: a fraction returns at once without waiting; cua.listWindows({pid})\n" +
	"- app.getState({query?, max_elements?, timeout_ms?, since?: \"latest\", tree_format?: \"elements\"}) returns {tree_markdown, window_title, snapshot_id, truncated?, elements?}; rows read as in get_window_state. In a script the walk stops after 250 nodes and 1000 ms unless you pass max_elements and timeout_ms, which cuts a browser page: pass about 3000 and 4000 there\n" +
	"- app.query({role?, name?}) finds named elements {element_token, role, label, frame}; app.waitFor({role?, name?, text?, gone?, timeout_ms?}) waits until the window shows (or no longer shows) them; text also matches static text\n" +
	"- app.click(t), doubleClick(t), typeText(text, t?), pressKey(\"escape\", t?), hotkey([\"cmd\",\"s\"]), scroll(t, \"down\", amount?), setValue(t, value), where t is {role, name, nth?}, an element_token, a row number of this app's last getState(), or [x, y] pixels of its last screenshot\n" +
	"- cua.call(tool, args) for click, press_key, type_text, scroll, get_window_state, list_windows or launch_app with their usual arguments.\n" +
	"Inputs go to the app in the background, as the other computer tools do; a control that reacts only to a real pointer needs the click tool with delivery_mode \"foreground\". A failed call throws (catch it to recover), and the error names the line. timeout_ms is the wall-time limit (default 60000, at most 100000); max_calls bounds driver calls (default 100, at most 500). A Skill that ships a script names it with script_file and passes its inputs as args, read in the script as the constant args. Return only what you need, such as extracted text; the result is cut at 40000 characters and carries no screenshots: call get_window_state to look at the window."

// scriptTimeoutMs bounds a script below the two-minute limit of one local
// tool call, so the Computer still answers when the script runs out of time.
const (
	scriptTimeoutMs        = 60000
	scriptMaxTimeoutMs     = 100000
	scriptResultCharacters = 40000
	scriptCallLogHead      = 4
	scriptCallLogTail      = 16
	// scriptCleanupMargin is the part of the call's remaining time kept for
	// the driver to end the script and answer, so a script that runs out of
	// time ends as a script error and not as an action of unknown outcome.
	scriptCleanupMargin = 15 * time.Second
)

func macScriptSchema() json.RawMessage {
	encoded, _ := json.Marshal(schema(map[string]any{
		"script":      map[string]any{"type": "string", "description": "JavaScript: the body of an async function. return the result."},
		"script_file": map[string]any{"type": "string", "description": "Instead of script: the absolute path of a .js file that a Skill ships, such as <skill dir>/scripts/read.js."},
		"args":        map[string]any{"type": "object", "description": "JSON values the script reads as the frozen constant args, such as {pid, window_id}."},
		"timeout_ms":  map[string]any{"type": "integer", "description": "Wall-time limit; default 60000, at most 100000."},
		"max_calls":   map[string]any{"type": "integer", "description": "Most driver calls; default 100, at most 500."},
	}))
	return encoded
}

// scriptForbidden are driver options a script may not use: foreground input
// would move the user's pointer and front windows without the Computer's
// takeover check, and the output-file options write outside the workspace.
var scriptForbidden = []string{"delivery_mode", "foreground", "screenshot_out_file", "debug_image_out", "out_file"}

// guardedScript puts args, DEADLINE and a guarded cua on the script's first
// line, so an error's line number still points into the body. The driver runs
// every cua call itself, so the guard checks each call as it runs: it copies
// the arguments to plain JSON, which is what the driver receives, and throws
// on an object key that names a forbidden option, however the script built
// it. A driver value with methods is wrapped wherever it sits in a result. The
// guard keeps its own references to the builtins it uses; the prelude then
// freezes the shared builtins and removes the function constructors. The body
// runs in strict mode with cua, globalThis, eval and Function shadowed. Before
// it runs, the prelude compiles the body on its own as one function body: one
// that does not compile alone could close the wrapper around it and reach the
// driver directly, so it is refused. DEADLINE is when the driver stops the
// script, in Unix milliseconds, so it can refuse an input whose result it
// could not verify in time. A positive inputLimit paces the script for the
// Computer's own browser: the guard waits a person's pause before each input,
// throws once the script tries to send more than inputLimit inputs, and
// refuses launch_app, whose site checks run only in the Daemon's own call.
func guardedScript(args, body string, deadline int64, inputLimit int) string {
	pattern := make([]string, 0, len(scriptForbidden))
	for _, word := range scriptForbidden {
		pattern = append(pattern, regexp.QuoteMeta(word))
	}
	source, _ := json.Marshal(`"use strict"; ` + body + "\n")
	return strings.ReplaceAll(`const args = Object.freeze(`+args+`), DEADLINE = `+strconv.FormatInt(deadline, 10)+`; const __guarded = (() => {
const keys = Object.keys, names = Object.getOwnPropertyNames, proto = Object.getPrototypeOf, define = Object.defineProperty, freeze = Object.freeze;
const apply = Reflect.apply, stringify = JSON.stringify, parse = JSON.parse, test = RegExp.prototype.test, then = Promise.prototype.then;
const plainProtos = [Object.prototype, Array.prototype, null], real = globalThis.cua;
const bad = /`+strings.Join(pattern, "|")+`/;
const limit = `+strconv.Itoa(inputLimit)+`, rest = real.sleep, random = Math.random, floor = Math.floor; let sent = 0;
const inputMethods = {__proto__: null, click: true, doubleClick: true, rightClick: true, drag: true, scroll: true, typeText: true, pressKey: true, hotkey: true, setValue: true};
const inputOps = {__proto__: null, click: true, double_click: true, right_click: true, drag: true, scroll: true, type_text: true, press_key: true, hotkey: true, set_value: true};
const input = (k, c) => inputMethods[k] === true || k === "call" && typeof c[0] === "string" && inputOps[c[0]] === true;
const check = v => { if (v !== null && typeof v === "object") { const ks = keys(v); for (let i = 0; i < ks.length; i++) { if (apply(test, bad, [ks[i]])) throw new Error("COMPUTER_SCRIPT_REFUSED: a script sends input in the background only and writes no files, so it may not use " + ks[i]); check(v[ks[i]]); } } };
const plain = v => { if (v === undefined || typeof v === "function") return undefined; const copy = parse(stringify(v)); check(copy); return copy; };
const live = v => { if (v === null || typeof v !== "object" && typeof v !== "function") return false; const p = proto(v); if (p !== plainProtos[0] && p !== plainProtos[1] && p !== plainProtos[2]) return true; const ks = keys(v); for (let i = 0; i < ks.length; i++) if (typeof v[ks[i]] === "function") return true; return false; };
const out = r => { if (live(r)) return wrap(r); if (r === null || typeof r !== "object") return r; const ks = keys(r); let c = null;
for (let i = 0; i < ks.length; i++) { const v = r[ks[i]], w = out(v); if (w === v) continue; if (!c) { c = proto(r) === plainProtos[1] ? [] : {}; for (let j = 0; j < ks.length; j++) define(c, ks[j], {value: r[ks[j]], enumerable: true, writable: true, configurable: true}); } define(c, ks[i], {value: w, enumerable: true, writable: true, configurable: true}); }
return c || r; };
const wrap = o => { const w = {}, seen = {};
for (let q = o; q && q !== plainProtos[0]; q = proto(q)) { const ns = names(q); for (let i = 0; i < ns.length; i++) { const k = ns[i]; if (k === "constructor" || seen[k]) continue; seen[k] = true;
define(w, k, {enumerable: true, get() { const v = o[k]; if (typeof v !== "function") return out(v); return function (...a) { const c = {length: a.length}; for (let i = 0; i < a.length; i++) define(c, i, {value: plain(a[i])});
const run = () => { const r = apply(v, o, c); return r !== null && typeof r === "object" && typeof r.then === "function" ? apply(then, r, [out]) : out(r); };
if (limit > 0 && (k === "launchApp" || k === "call" && c[0] === "launch_app")) throw new Error("COMPUTER_SCRIPT_REFUSED: a script in the Computer's own browser opens no app or URL, so the site checks of launch_app hold; call launch_app as its own tool");
if (limit <= 0 || !input(k, c)) return run();
if (++sent > limit) throw new Error("COMPUTER_SCRIPT_INPUT_LIMIT: a script sends at most " + limit + " inputs to the Computer's own browser; return what you have, look at the window, then continue in a new script");
return apply(then, apply(rest, real, [`+strconv.Itoa(scriptInputPauseMin)+` + floor(random() * `+strconv.Itoa(scriptInputPauseSpan)+`)]), [run]); }; }}); } }
return freeze(w); };
return wrap(real); })();
try { new ((async function () {}).constructor)(`+string(source)+`); } catch (e) { throw new Error("COMPUTER_SCRIPT_REFUSED: the script is not one complete function body: " + e.message); }
for (const f of [function () {}, async function () {}, function* () {}, async function* () {}]) Object.defineProperty(Object.getPrototypeOf(f), "constructor", {value: undefined, writable: false, configurable: false});
for (const b of [Object, Object.prototype, Array, Array.prototype, Function.prototype, Promise, Promise.prototype, JSON, Reflect, RegExp, RegExp.prototype, String.prototype, Symbol]) Object.freeze(b);
return await (function (cua, globalThis, eval, Function) { return (async function () { "use strict"; `, "\n", " ") + body + scriptEpilogue
}

// scriptEpilogue closes what guardedScript opened.
const scriptEpilogue = "\n}).call(undefined); })(__guarded, undefined, undefined, undefined);"

// forbiddenKey reports whether value holds an object key that names word.
func forbiddenKey(value any, word string) bool {
	switch typed := value.(type) {
	case map[string]any:
		for key, inner := range typed {
			if strings.Contains(key, word) || forbiddenKey(inner, word) {
				return true
			}
		}
	case []any:
		for _, inner := range typed {
			if forbiddenKey(inner, word) {
				return true
			}
		}
	}
	return false
}

// scriptArguments checks a run_script call, reads a Skill's script file into
// script with args as a constant on its first line, and fits its time limit
// into what remains of the call after waiting for the desktop lane. In a
// reviewed Run, whose review scope is not empty, a script file runs only as
// the judge allowed it in that scope: the body it read and the args it saw.
func scriptArguments(ctx context.Context, arguments map[string]any, reviewScope string, inputLimit int) error {
	for key := range arguments {
		switch key {
		case "script", "script_file", "args", "timeout_ms", "max_calls":
		default:
			return fmt.Errorf("run_script takes script or script_file, args, timeout_ms and max_calls, not %s: %w", key, errNotSent)
		}
	}
	script, _ := arguments["script"].(string)
	if path, _ := arguments["script_file"].(string); path != "" {
		if strings.TrimSpace(script) != "" {
			return fmt.Errorf("run_script takes script or script_file, not both: %w", errNotSent)
		}
		body, err := permission.SkillScript(path)
		if err == nil && reviewScope != "" {
			err = permission.TakeApprovedScript(reviewScope, path, body, arguments["args"], time.Now())
		}
		if err != nil {
			return fmt.Errorf("%s: %w", err.Error(), errNotSent)
		}
		script = body
	}
	// Forbidden driver options are looked for in the script's own code and
	// among the keys of args, which the script could hand to a driver call
	// whole; the values of args carry page and user text and are not.
	for _, word := range scriptForbidden {
		if strings.Contains(script, word) || forbiddenKey(arguments["args"], word) {
			return fmt.Errorf("COMPUTER_SCRIPT_REFUSED: a script sends input in the background only and writes no files, so it may not use %s; send a foreground click with the click tool: %w", word, errNotSent)
		}
	}
	if strings.TrimSpace(script) == "" {
		return fmt.Errorf("run_script needs a script or script_file: %w", errNotSent)
	}
	values := map[string]any{}
	if raw, present := arguments["args"]; present {
		var ok bool
		if values, ok = raw.(map[string]any); !ok {
			return fmt.Errorf("run_script args must be an object: %w", errNotSent)
		}
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return fmt.Errorf("run_script args are not JSON: %w", errNotSent)
	}
	timeout, ok := arguments["timeout_ms"].(float64)
	if !ok || timeout <= 0 {
		timeout = scriptTimeoutMs
	}
	timeout = min(timeout, scriptMaxTimeoutMs)
	if deadline, ok := ctx.Deadline(); ok {
		left := float64((time.Until(deadline) - scriptCleanupMargin).Milliseconds())
		if left < 5000 {
			return fmt.Errorf("COMPUTER_BUSY: too little of this call's time is left after waiting for other input; send the script again: %w", errNotSent)
		}
		timeout = min(timeout, left)
	}
	arguments["timeout_ms"] = timeout
	delete(arguments, "script_file")
	delete(arguments, "args")
	arguments["script"] = guardedScript(string(encoded), script, time.Now().Add(time.Duration(timeout)*time.Millisecond).UnixMilli(), inputLimit)
	return nil
}

// compactScriptResult keeps a script's result small in the model's context:
// the driver call log keeps its first and last lines, the text is cut at a
// fixed length, and the screenshots of the reads the script made are dropped.
// A screenshot the script did not return invites the model to second-guess
// the return value; get_window_state shows the window when it is needed.
func compactScriptResult(result json.RawMessage) json.RawMessage {
	var reply map[string]json.RawMessage
	var content []map[string]any
	if json.Unmarshal(result, &reply) != nil || json.Unmarshal(reply["content"], &content) != nil {
		return result
	}
	kept := []map[string]any{}
	for _, item := range content {
		if item["type"] != "text" {
			continue
		}
		if text, ok := item["text"].(string); ok {
			item["text"] = compactScriptText(text)
		}
		kept = append(kept, item)
	}
	encoded, err := json.Marshal(kept)
	if err != nil {
		return result
	}
	reply["content"] = encoded
	compacted, err := json.Marshal(reply)
	if err != nil {
		return result
	}
	return compacted
}

func compactScriptText(text string) string {
	head, calls, found := strings.Cut(text, "\ncalls:\n")
	if found {
		lines := strings.Split(strings.TrimRight(calls, "\n"), "\n")
		if len(lines) > scriptCallLogHead+scriptCallLogTail {
			omitted := len(lines) - scriptCallLogHead - scriptCallLogTail
			lines = append(append(lines[:scriptCallLogHead:scriptCallLogHead], fmt.Sprintf("  … %d calls omitted …", omitted)), lines[len(lines)-scriptCallLogTail:]...)
		}
		text = head + "\ncalls:\n" + strings.Join(lines, "\n")
	}
	if runes := []rune(text); len(runes) > scriptResultCharacters {
		text = string(runes[:scriptResultCharacters]) + "\n… the result was cut here; return less, such as only the fields you need."
	}
	return text
}
