import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import { selectAction } from "../dist/ui.js";

async function chooseWithKeys(keys) {
  const initialKeypressListeners = process.stdin.listenerCount("keypress");
  const selection = selectAction();

  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.stdin.listenerCount("keypress") >= initialKeypressListeners + 3) break;
    await nextTurn();
  }
  assert.ok(process.stdin.listenerCount("keypress") >= initialKeypressListeners + 3);

  for (const name of keys) {
    process.stdin.emit("keypress", name, { name });
    await nextTurn();
  }
  process.stdin.emit("keypress", "\r", { name: "return" });

  return selection;
}

test("s moves to the next menu item even when another item starts with s", async () => {
  assert.equal(await chooseWithKeys(["s"]), "my-reservations");
});

test("w moves back one menu item after navigating down", async () => {
  assert.equal(await chooseWithKeys(["s", "s", "w"]), "my-reservations");
});
