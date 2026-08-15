# Windows variant — platform deltas from the desktop (macOS) design

The Windows build uses the **same** design as the desktop mockups in this
bundle — identical **size, panel, shape**, layout, spacing, and every screen.
Do not redesign anything for Windows. There are exactly **two** platform
differences:

## 1. Hotkeys — no Cmd key

Windows has no Cmd key. Anywhere the macOS design uses **Cmd**, use **Ctrl** (and
the standard Windows modifiers) instead. Bindings and behavior are otherwise the
same — only the modifier key changes.

## 2. Window controls (title-bar chrome)

- **macOS:** the red / yellow / green traffic-light controls, on the **left**.
- **Windows:** the standard minimize / maximize / close controls, on the
  **right** (native Windows style).

Only the window-control cluster differs — its position and native style follow
each OS's convention. Everything inside the window is unchanged.

---

**Everything else — size, panel, shape, and every other element — is identical
across macOS and Windows.**
