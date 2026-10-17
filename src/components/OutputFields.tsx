import Icon from "./Icon";

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Format and output folder fields, shared by the export and combine panels. */
export default function OutputFields(props: {
  format: string;
  onFormat: (format: string) => void;
  outputDir: string;
  onPickDir: () => void;
  onClearDir: () => void;
  /** What "same format" and "default folder" refer to, e.g. "original" or "first clip". */
  source: string;
}) {
  return (
    <>
      <div className="field">
        <span className="label">Format</span>
        <select value={props.format} onChange={(e) => props.onFormat(e.target.value)}>
          <option value="same">Same as {props.source}</option>
          <option value="mp3">MP3</option>
          <option value="m4a">M4A (AAC)</option>
          <option value="wav">WAV</option>
          <option value="flac">FLAC</option>
        </select>
      </div>
      <div className="field">
        <span className="label">Folder</span>
        <button className="path-btn" onClick={props.onPickDir} title={props.outputDir || "Choose output folder"}>
          <Icon name="folder" size={14} />
          <span>{props.outputDir ? fileName(props.outputDir) : `Next to ${props.source}`}</span>
        </button>
        {props.outputDir && (
          <button className="icon-btn" onClick={props.onClearDir} title={`Save next to the ${props.source}`}>
            <Icon name="close" size={12} />
          </button>
        )}
      </div>
    </>
  );
}
