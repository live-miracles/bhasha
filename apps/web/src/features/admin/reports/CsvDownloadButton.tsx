import { useState } from "react";

interface CsvDownloadButtonProps {
  onDownload: () => Promise<void>;
}

type DownloadState = "idle" | "downloading" | "ready" | "failed";

export function CsvDownloadButton({ onDownload }: CsvDownloadButtonProps) {
  const [state, setState] = useState<DownloadState>("idle");

  async function handleClick() {
    setState("downloading");
    try {
      await onDownload();
      setState("ready");
    } catch (_error) {
      setState("failed");
    }
  }

  return (
    <div className="admin-csv-download">
      <button
        className="admin-btn-secondary"
        disabled={state === "downloading"}
        onClick={() => void handleClick()}
        type="button"
      >
        Download CSV
      </button>
      {state === "downloading" ? <span>Preparing download...</span> : null}
      {state === "ready" ? <span role="status">Download ready</span> : null}
      {state === "failed" ? (
        <span role="alert">Download failed</span>
      ) : null}
    </div>
  );
}
