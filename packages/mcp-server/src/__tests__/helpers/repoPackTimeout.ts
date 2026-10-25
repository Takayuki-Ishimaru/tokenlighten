// repoPackTimeout.ts — the time limit for a test that packs THIS repository:
// a task_pack whose workspace is the monorepo root (~18,000 tracked files)
// rather than a small fixture.
//
// The first such pack in a process is the slowest single step in the suite.
// It walks the tree, builds the source index (over the 32 MB persistence cap,
// so every process rebuilds it) and, for request-item readiness, reads and
// line-splits the text of the whole workspace to prove which requested items
// are absent. All of it is CPU work that the test cannot shortcut without
// changing the workspace it pins. Later packs in the same process reuse the
// caches (T03's second identical call: 1.9 s).
//
// Measured 2026-10-20 on an M4 (4 performance + 6 efficiency cores):
//
//   cold first call, machine otherwise idle (load 3-8)
//     replayCorpus M3, spawned server (pathless T07)        10.6-16.7 s
//     autoProfileHintless T03, in-process                         33.3 s
//     ledgerDecisionIntegration F1 positive, in-process           35.7 s
//   where T03's goes (CPU profile): 16.9 s literal scans for request-item
//   readiness, 7.1 s source index, 5.4 s repository walk, 2.4 s graph write
//
//   the same M3 call beside `yes` CPU burners       first call   second
//      0 burners (load ~3)                              10.6 s     4.8 s
//     10 burners (load 4 -> 15)                         22.6 s     9.2 s
//     20 burners (load 17 -> 27)                        31.8 s    15.3 s
//     40 burners (load 29 -> 69)                        92.7 s    38.4 s
//
// Five sessions running full suites side by side reached load 25-110, and the
// former limits (M3's 45 s RPC, T03's and F1's 60 s) failed there. At the
// heaviest measured point the cold call ran 8.7x its idle time, so the slowest
// case above extrapolates to ~310 s. The limit leaves about twice that, the
// same ten minutes firstPackPrecisionEval already allows its cold-source
// matrix. Nothing here asserts speed: a hang still fails, ten minutes in.
export const REPO_PACK_TIMEOUT_MS = 600_000;
