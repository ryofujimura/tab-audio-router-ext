# Tab Audio Router

![Route different tabs to different outputs](docs/images/img.jpg)

> Send **each browser tab’s audio to a different device** on Mac.  
> Example: YouTube → TV, Zoom → Headphones.

---

## Why this exists

macOS + browsers don’t let you easily control audio **per tab**.

This fixes that — right from the **toolbar popup UI**.

---

## How it works

![Extension popup to choose tab output](docs/images/Screenshot.jpg)

- Click the extension button in the browser toolbar
- See tabs that are currently producing audio
- Choose an output device for each tab
- Set volume per tab with a simple slider
- (Optional) Set macOS system output volume from the popup

---

## What you can do

- 🎧 Zoom in headphones, music on speakers  
- 📺 Send a tab to your TV while working on laptop audio  
- 🔀 Run multiple tabs with different outputs and volume levels

---

## Install (30 seconds)

1. Download / clone this repo  
2. Go to `chrome://extensions`  
3. Enable **Developer Mode**  
4. Click **Load unpacked** → select this folder  

---

## Optional: enable system volume control (macOS)

The popup can control macOS output volume using a native helper.

1. Find your extension ID in `chrome://extensions`  
2. Run:

```bash
chmod +x ./native-host/install-mac.sh
./native-host/install-mac.sh <YOUR_EXTENSION_ID>
```

3. Reload the extension

After setup, the popup shows **System output volume** at the top.

---

## Limitations (important)

- Only works on sites using standard `<audio>/<video>`  
- Needs to be tested on web apps(Ex: Zoom web, Spotify web)
- Needs to be tested on browswers (Ex: Chrome, Arc, Brave, Edge)  

---

## Status

Early tool. Works well on common sites, not universal yet.

Tested on:
- [ ] **Chrome** — macOS  
- [ ] **Chrome** — Windows  
- [ ] **Edge** — Windows  
- [ ] **Brave** — macOS  
- [x] **Arc** — macOS
      - Version 1.143.2 (79250) Chromium Engine Version 147.0.7727.102  
- [ ] **Chromium** — Linux
 
---
