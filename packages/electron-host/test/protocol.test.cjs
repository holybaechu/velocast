"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCommand, loadUrl, parseScriptTitle } = require("../protocol.cjs");

test("script completion only accepts the current request token", () => {
  const old = 'velocast-script-result:script-6:ok:{"frame":6}';
  const current = 'velocast-script-result:script-7:ok:{"frame":7}';
  assert.equal(parseScriptTitle(old, "script-7"), null);
  assert.deepEqual(parseScriptTitle(current, "script-7"), {
    ok: true,
    result: '{"frame":7}',
  });
  assert.deepEqual(
    parseScriptTitle(
      "velocast-script-result:script-7:err:seek failed: late image",
      "script-7",
    ),
    {
      ok: false,
      error: "seek failed: late image",
    },
  );
});

test("commands reject unsupported operations and unsafe request IDs", () => {
  assert.equal(
    parseCommand('{"id":7,"method":"paint","generation":8,"copy":true}').id,
    7,
  );
  assert.throws(
    () => parseCommand('{"id":9007199254740992,"method":"paint"}'),
    /safe integer/,
  );
  assert.throws(() => parseCommand('{"id":1,"method":"eval"}'), /unsupported/);
});

test("load accepts the native controller local file entry and web server URLs", () => {
  assert.equal(
    loadUrl("file:///D:/projects/My Scene/index.html"),
    "file:///D:/projects/My%20Scene/index.html",
  );
  assert.equal(
    loadUrl("http://127.0.0.1:3000/scene"),
    "http://127.0.0.1:3000/scene",
  );
  assert.equal(
    loadUrl("https://example.test/scene"),
    "https://example.test/scene",
  );
});

test("load rejects executable, inline, and relative URLs", () => {
  for (const value of [
    "javascript:alert(1)",
    "data:text/html,<script>x</script>",
    "velocast://renderer",
    "./index.html",
    "C:\\scene\\index.html",
  ]) {
    assert.throws(() => loadUrl(value), /HTTP\(S\) or file URL/);
  }
});
