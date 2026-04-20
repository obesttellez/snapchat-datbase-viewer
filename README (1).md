# Snapchat Message Viewer

A client-side tool that converts your `message_logger.db` into a self-contained HTML chat viewer. Everything runs in your browser — no data is ever uploaded to a server.

## Usage

1. Visit the GitHub Pages site
2. Drop your `message_logger.db` file onto the page
3. Wait a few seconds while it processes
4. Download the generated `snapchat_viewer.html`
5. Open that file locally to browse all your chats

## How it works

- Uses [sql.js](https://github.com/sql-js/sql.js) to read the SQLite database entirely in-browser (WebAssembly)
- Decodes Snapchat's protobuf-encoded message content with a custom varint parser
- Generates a fully self-contained single-file HTML viewer with all messages embedded

## Hosting on GitHub Pages

1. Fork or clone this repo
2. Go to **Settings → Pages**
3. Set source to `main` branch, `/ (root)` folder
4. Your site will be live at `https://yourusername.github.io/snapchat-viewer`

## Privacy

All processing happens locally in your browser. No data leaves your device.
