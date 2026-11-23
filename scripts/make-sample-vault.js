// Generates examples/sample-vault: a small, harmless Obsidian vault used for
// demos, README screenshots and tests. Run: node scripts/make-sample-vault.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'examples', 'sample-vault');

const notes = {
  'Home.md': `# Home
Welcome to the **sample vault**. Every note is a star; every folder is a constellation.

> [!tip] Try it
> Click a star, press \`A\` for a random note or \`Ctrl+K\` to search.

- Start with [[Black holes]] and [[Note-taking]]
- Projects live in [[Telescope build]] and [[Reading list]]
- Daily notes: [[2026-11-20]], [[2026-11-21]]
`,
  'Astronomy/Black holes.md': `---
tags: [astronomy, physics]
aliases: [Black hole]
---
# Black holes
Regions where gravity is so strong that light cannot escape. See [[Event horizon]], [[Photon sphere]] and [[Accretion disk]].

## Formation
Most form when a massive [[Stars|star]] collapses.

## Observation
The first image came from the [[Event Horizon Telescope]]. #astronomy/observation
`,
  'Astronomy/Event horizon.md': `# Event horizon
The boundary of a [[Black holes|black hole]]. Its radius is the [[Schwarzschild radius]].

## Time dilation
Clocks near the horizon run slow relative to distant observers ([[General relativity]]).
`,
  'Astronomy/Photon sphere.md': `# Photon sphere
At 1.5 × the [[Schwarzschild radius]] light can orbit a [[Black holes|black hole]]. It creates the bright ring seen in renders like this app's.
`,
  'Astronomy/Accretion disk.md': `---
tags: [astronomy]
---
# Accretion disk
Hot gas spiralling into a [[Black holes|black hole]].

## Doppler beaming
The side moving towards us looks brighter.

## Temperature
Hotter towards the inner edge (the ISCO).
`,
  'Astronomy/Schwarzschild radius.md': `# Schwarzschild radius
\`r = 2GM / c²\` — the size of the [[Event horizon]] of a non-rotating mass. Part of [[General relativity]].
`,
  'Astronomy/General relativity.md': `---
tags: [physics]
---
# General relativity
Einstein's theory of gravity as curved spacetime.

## Predictions
- [[Black holes]]
- Gravitational lensing (see [[Photon sphere]])
- Gravitational waves
`,
  'Astronomy/Stars.md': `# Stars
Balls of plasma powered by fusion. The heaviest end as [[Black holes]].

## Life cycle
Nebula → main sequence → giant → remnant.
`,
  'Astronomy/Event Horizon Telescope.md': `---
tags: [astronomy/observation]
---
# Event Horizon Telescope
A planet-sized array of radio telescopes that imaged M87* and Sgr A*. Related: [[Black holes]], [[Telescope build]].
`,
  'Learning/Note-taking.md': `---
tags: [pkm]
---
# Note-taking
Write notes in your own words and **link** them. See [[Zettelkasten]], [[Spaced repetition]] and [[Feynman technique]].

==Links are more valuable than folders.==
`,
  'Learning/Zettelkasten.md': `---
tags: [pkm]
---
# Zettelkasten
Atomic notes with unique ids and dense links. Inspired [[Note-taking]] apps like Obsidian.

## Rules
1. One idea per note
2. Link every new note
3. Prefer [[Evergreen notes]]
`,
  'Learning/Evergreen notes.md': `# Evergreen notes
Notes that keep growing over time. They are the opposite of a [[Reading list]] dump.
`,
  'Learning/Spaced repetition.md': `---
tags: [learning]
---
# Spaced repetition
Review at growing intervals to beat the forgetting curve. Pairs well with [[Feynman technique]].
`,
  'Learning/Feynman technique.md': `---
tags: [learning]
---
# Feynman technique
Explain a topic simply, find the gaps, go back to the source.

## Steps
- Pick a concept (e.g. [[Event horizon]])
- Teach it to a child
- Review and simplify
`,
  'Learning/Deep work.md': `---
tags: [productivity]
---
# Deep work
Long, distraction-free sessions. Plan them in [[2026-11-21]].
`,
  'Projects/Telescope build.md': `---
tags: [project, astronomy]
---
# Telescope build
Build a 6" Dobsonian to look at [[Stars]].

## Tasks
- [x] Buy mirror
- [x] Cut the tube
- [ ] Build the rocker box
- [ ] Collimate

## Notes
Compare with the [[Event Horizon Telescope]] — slightly smaller.
`,
  'Projects/Reading list.md': `---
tags: [project, books]
---
# Reading list
- [x] *A Brief History of Time*
- [ ] *Black Holes and Time Warps* → [[Black holes]]
- [ ] *How to Take Smart Notes* → [[Zettelkasten]]
- [ ] *Deep Work* → [[Deep work]]
`,
  'Projects/Garden.md': `---
tags: [project]
---
# Garden
Tomatoes, basil and a lot of patience.

## Tasks
- [ ] Compost
- [ ] Build a trellis
`,
  'Projects/Website.md': `---
tags: [project, code]
---
# Website
Personal site to publish [[Evergreen notes]].

## Stack
Static site, markdown, no tracking.

## Tasks
- [x] Domain
- [ ] Theme
`,
  'Journal/2026-11-20.md': `# 2026-11-20
Read about the [[Photon sphere]]. Started the [[Telescope build]]. #journal
`,
  'Journal/2026-11-21.md': `# 2026-11-21
Two hours of [[Deep work]] on [[Website]]. Reviewed cards ([[Spaced repetition]]). #journal
`,
  'Journal/2026-11-22.md': `# 2026-11-22
Watered the [[Garden]]. Idea: a note about [[Wormholes]] (not written yet). #journal
`,
  'Inbox/Quick idea.md': `# Quick idea
Map my notes as a galaxy? (You are looking at it.)
`,
  'Inbox/Orphan thought.md': `# Orphan thought
This note links nowhere, and nothing links here. The stats panel will find it.
`,
};

fs.rmSync(root, { recursive: true, force: true });
for (const [rel, body] of Object.entries(notes)) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}
fs.mkdirSync(path.join(root, '.obsidian'), { recursive: true });
fs.writeFileSync(path.join(root, '.obsidian', 'app.json'), '{}\n');
console.log(`Wrote ${Object.keys(notes).length} notes to ${root}`);
