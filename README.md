# STL Kit

Browser-based STL viewer built with [Three.js](https://threejs.org/) and Vite.

- Drag and drop one or more `.stl` files anywhere in the window (or use **Open STL…**).
- Drag with the mouse to orbit, scroll to zoom, right-drag to pan.
- The left sidebar lists loaded objects with their bounding-box size in millimetres,
  shown as `X × Y × Z` (left-to-right × front-to-back × bottom-to-top), using the
  slicer convention that STL units are millimetres and Z is up. Each object also gets a
  wireframe box with dimension labels in the 3D view.
- Select objects in the sidebar (Cmd/Ctrl-click or Shift-click for several), then use the
  icon toolbar (hover for labels): **Hide/Show**, **Delete**, **Spread** (move the
  selection next to the other objects so nothing overlaps), **Rotate…** (exact angles),
  **Move…** (footprint centre X/Y and bottom height Z in mm), **Scale…** (percent per
  axis, uniform by default, relative to the original file size or to the current size),
  and **X/Y/Z 90°** quick rotates about the world axes. Dialogs preview live; Cancel or
  Escape restores the previous state.
- **Save** (green) writes the selected objects back to their original files as binary STL
  with the current rotation, scale and position baked in. A confirmation dialog lists the
  files and warns about overwriting; the browser then asks for write permission per file.
  This uses the File System Access API, so it works in Chrome and Edge for files that were
  dropped in or opened with the **Open STL…** picker. Firefox and Safari cannot write back.
- Keyboard: `Space` hide/show, `Delete` delete, `Backspace` reset view, `Esc` clear
  selection, `a` select all.

## Run

```bash
npm install
npm run dev
```

Then open the URL Vite prints (default http://localhost:5173).

## Build

```bash
npm run build
```

The static site is written to `dist/`.
