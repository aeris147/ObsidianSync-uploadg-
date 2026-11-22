##ObsidianSync

A two-way synchronization plugin for Obsidian that uses the UploadG API to sync your vault with cloud storage without requiring a self-hosted server.

## Features

- Two-way synchronization between your local vault and UploadG.
- Automatic file and folder synchronization.
- SHA-256 hashing to detect file changes.
- Conflict resolution based on modification timestamps.
- Local backups before overwriting existing files.
- Sync preview to review changes before applying them.
- Multipart uploads for large files.
- Optional cloud deletion when files are deleted locally.
- Custom folder exclusions.
- Synchronization logs and error reports.

## Requirements

- Obsidian 1.4.0 or later.
- An UploadG account.
- An UploadG API token.

## Installation

### Manual Installation

1. Download `main.js` and `manifest.json` from this repository.
2. Open your Obsidian vault directory.
3. Navigate to `.obsidian/plugins/`.
4. Create a folder named `uploadg-sync`.
5. Place both downloaded files inside that folder.
6. Restart Obsidian.
7. Enable UploadG Sync under Settings → Community plugins.

## Configuration

1. Open Settings → Community plugins → UploadG Sync.
2. Generate an API token from [UploadG Developer Settings](https://uploadg.com/account-settings).
3. Paste your API token into the plugin settings.
4. Set your remote folder.

Example:

```text
ObsidianSync/notes
```

The remote folder will be created automatically if it does not exist.

### Available Settings

| Setting | Description |
|---|---|
| API Token | UploadG API authentication token |
| Remote Folder | Cloud folder used for vault synchronization |
| Plugin Data Folder | Folder used to store synchronization metadata |
| Remote Folder ID | Optional ID of an existing cloud folder |
| Download URL Template | UploadG file download endpoint |
| Delete from Cloud | Option to propagate local deletions |
| Ignored Folders | Paths excluded from synchronization |
| Extra Excluded Paths | Additional vault paths to ignore |

## Usage

The plugin provides three commands:

| Command | Description |
|---|---|
| Sync with UploadG | Starts synchronization |
| Preview sync | Shows planned changes without modifying files |
| Test connection and detect download URL | Tests the API connection and detects the download endpoint |

You can also start synchronization using the refresh icon in the Obsidian ribbon.

Default keyboard shortcut:

`Ctrl + Shift + U`

## Synchronization Behaviour

The plugin compares local and cloud files using SHA-256 hashes and synchronization metadata.

| Situation | Behaviour |
|---|---|
| New local file | Uploads to cloud |
| New cloud file | Downloads locally |
| Modified local file | Uploads updated version |
| Modified cloud file | Downloads updated version |
| Both versions modified | Newer modification time wins |
| Same modification time | Local version wins |
| Unchanged file | Skips synchronization |

## Backups

Before overwriting an existing local file with a cloud version, the plugin creates a backup.

Backups are stored in:

```text
.obsidian/plugins/uploadg-sync/backups/
```

Backups older than 14 days are automatically removed.

## Cloud Structure

The plugin keeps synchronized files and metadata in separate folders.

Example:

```text
ObsidianSync/
├── notes/
│   ├── Daily Notes/
│   ├── Projects/
│   └── Notes.md
│
└── _sync/
    └── notes/
        └── index.json
```

The `index.json` file stores file hashes and original modification timestamps.

## Important Notes

- The `.obsidian` directory is always excluded.
- Local files are never deleted by the plugin.
- Cloud deletion propagation is disabled by default.
- Empty files may be skipped if UploadG refuses zero-byte uploads.
- Synchronization is triggered manually.
- Keep independent backups of important vault data.

## Logs

Synchronization logs are stored at:

```text
.obsidian/plugins/uploadg-sync/sync-log.txt
```

Check this file when troubleshooting synchronization errors.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.
