import { test, expect } from "bun:test";
process.env.OPTCHAT_VIEW = "300";
const { open, lock } = await import("./db");
const { Memory } = await import("./memory");
const { Compactor } = await import("./compactor");

test("fold, merge, zoom, reload", async () => {
  const dir = `/tmp/optchat-test-${Date.now()}`;
  const db = open(dir);
  const mem = new Memory(db);
  const comp = new Compactor(mem);
  // Fake model: any node that is not free gets a short fake summary.
  comp.build = async (l, i) => mem.save(l, i, `S${l}.${i}`);
  for (let k = 0; k < 40; k++) { mem.log(k % 2 ? "talk" : "user", `msg ${k}`); comp.pump(); }
  await comp.drain();
  const v1 = mem.render().join("");
  // The view tiles [0, T).
  let at = 0; for (const p of mem.view) { expect(p.i * 2 ** p.l).toBe(at); at = (p.i + 1) * 2 ** p.l; }
  expect(at).toBe(40);
  expect(mem.settled()).toBe(true);
  expect(mem.zoom(5, 1)).toBe("5+0|talk: msg 5");
  expect(mem.zoom(3, 2)).toBe("No line 3+2.");
  // Reloading folds the same view again.
  const mem2 = new Memory(open(dir));
  expect(mem2.render().join("")).toBe(v1);
});

test("lock", async () => {
  const dir = `/tmp/optchat-lock-${Date.now()}`; open(dir);
  const un = await lock(dir);
  await expect(lock(dir)).rejects.toThrow();
  un();
  const un2 = await lock(dir); un2();
});
