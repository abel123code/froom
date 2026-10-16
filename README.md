# Froom

A Windows desktop app that records your screen with a round face bubble and has a simple editor for trimming and cutting dead space.

## Run

```
npm install
npm run dev
```

If it says `Electron uninstall`, run `node node_modules/electron/install.js` once.

Build an installer: `npm run build:win` (output in `dist/`).

## Use

1. Pick **Screen + Cam**, **Screen only** or **Cam only**, then choose a screen or window, camera and mic.
2. **Start recording**. You get a 3-2-1 countdown, then a floating control bar for stop, pause, restart, delete and camera on/off. The control bar never shows up in the video.
   - Drag the face bubble anywhere. Hover over it to change its size (S/M/L) or shape.
   - **Draw on screen:** click the pen on the control bar (or **Alt+Shift+D**). Pick pen, arrow or circle and a colour. Marks fade after 5 seconds. Press Esc or click the pen again to stop drawing.
   - **Click highlights:** a yellow ring shows where you click. Turn it off with "Highlight clicks" in the recorder panel.
   - Drawing and click rings only work when recording the entire screen.
   - Hotkeys: **Alt+Shift+L** to stop, **Alt+Shift+P** to pause, **Alt+Shift+D** to draw.
3. After you stop, the editor opens:
   - Drag the yellow handles to trim the start and end.
   - Drag across the timeline to select a part, then **Cut selection** (or press Delete).
   - **Remove silences** cuts every pause longer than the minimum length. You can tune it.
   - Click a red part to select it, then **Restore part**. **Ctrl+Z** undoes.
4. **Save as MP4** writes the finished video to `Videos\Froom\<title>.mp4`.

Raw recordings and your edits are kept in `Videos\Froom\.recordings`, so you can re-edit and export again later.

## How the face bubble gets into the video

- **Entire screen:** the bubble window is captured with the screen, so the video shows it exactly where you put it.
- **Single window or Cam only:** the camera is drawn into the video itself. In window mode it goes in the bottom-left corner.
