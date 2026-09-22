# STL Kit

A small, browser-only viewer and prep tool for STL files, aimed at 3D printing.

**Live app:** https://lehotskysamuel.github.io/stl-kit/

## What it is for

When you download a model for printing you often want to answer a few quick questions
before opening a slicer: what does it look like, how big is it in millimetres, which way
up should it go, does it need scaling, and does it fit next to the other parts? STL Kit
does exactly that in a browser tab, with no install and no upload. Files are read and
written entirely on your machine.

- Drop one or more `.stl` files into the window (or use **Open STL…**) and orbit around
  them with the mouse: left-drag rotates, scroll zooms, right-drag pans.
- Every object gets a wireframe bounding box with its dimensions in mm, shown as
  `X × Y × Z` (left-to-right × front-to-back × bottom-to-top), using the slicer
  convention that STL units are millimetres and Z is up. Objects are placed resting on
  the build plate.
- The sidebar lists loaded objects. Select one or several (Cmd/Ctrl-click, Shift-click)
  and use the toolbar to hide/show, delete, spread them apart so nothing overlaps,
  rotate by 90° about X, Y or Z, or open the **Rotate…**, **Move…** and **Scale…**
  dialogs for exact values with live preview. **Center** shifts the whole scene, every
  object together, so it sits centred on the plate.
- **Save** (green) writes the selected objects back to their original files as binary
  STL with the current rotation, scale and position baked in, after a confirmation that
  lists the files and warns about overwriting. This relies on the File System Access
  API, so it works in Chrome and Edge; Firefox and Safari can view but not write back.
- Keyboard: `Space` hide/show, `Delete` delete, `Backspace` reset view, `Esc` clear
  selection, `a` select all.

A note on units: STL files carry no unit information. STL Kit, like every slicer,
reports the raw numbers as millimetres. If a model was authored in centimetres it will
show ten times too small; use **Scale…** at 1000 % or scale it in your slicer.

## How it is built

Plain JavaScript with [Three.js](https://threejs.org/) for rendering and
[Vite](https://vite.dev/) for bundling. STL parsing and export run in a Web Worker so the
UI stays responsive with multi-million-triangle files. There is no backend. Pushes to
`main` are built and deployed to GitHub Pages by the workflow in
`.github/workflows/deploy.yml`.

## Local development

Requires [Node.js](https://nodejs.org/) 20 or newer.

```bash
git clone git@github.com:lehotskysamuel/stl-kit.git
cd stl-kit
npm install
npm run dev
```

Then open the URL Vite prints (http://localhost:5173 by default). Edits reload
automatically.

To check the production build locally:

```bash
npm run build
npm run preview
```

The preview serves the built site at http://localhost:4173/stl-kit/ (the same base path
GitHub Pages uses).
