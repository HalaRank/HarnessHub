import {
  attachment,
  IMAGE_ACCEPT,
  type ImageAttachment,
  imageBytes,
  imageSource,
  isImageAttachment,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
} from "@harnesshub/shared";
import { type ClipboardEvent, useEffect, useRef, useState } from "react";
import type { DesktopDraft } from "./drafts";

export function ImagePreviews({
  images,
  remove,
  disabled = false,
}: {
  images: ImageAttachment[];
  remove?: (index: number) => void;
  disabled?: boolean;
}) {
  if (!images.length) return null;
  return (
    <section className="image-attachments" aria-label="文件附件">
      {images.map((image, index) => (
        // Previews are stateless, and repeated copies of the same file are supported.
        // biome-ignore lint/suspicious/noArrayIndexKey: each occurrence is removable by position
        <div className="image-attachment" key={`${index}:${image.name}`}>
          {isImageAttachment(image) ? (
            <img src={imageSource(image)} alt={image.name} title={image.name} />
          ) : (
            <div className="file-attachment-preview" aria-hidden="true">
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              >
                <path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 13h8M8 17h5" />
              </svg>
              <small>
                {imageBytes(image) < 1024
                  ? `${imageBytes(image)} B`
                  : `${Math.ceil(imageBytes(image) / 1024)} KB`}
              </small>
            </div>
          )}
          <span className="image-attachment-name" title={image.name}>
            {image.name}
          </span>
          {remove && (
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除${isImageAttachment(image) ? "图片" : "文件"} ${image.name}`}
              onClick={() => remove(index)}
            >
              ×
            </button>
          )}
        </div>
      ))}
    </section>
  );
}

export async function readAttachment(file: File): Promise<ImageAttachment> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error(`文件 ${file.name} 超过 5 MiB。`);
  const image = IMAGE_ACCEPT.split(",").includes(file.type);
  if (image && !file.size) throw new Error("图片内容为空。");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取文件 ${file.name}`));
    reader.onabort = () => reject(new Error("文件读取已取消。"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
  return attachment.parse({
    ...(image ? {} : { kind: "file" as const }),
    name: file.name.slice(0, 255) || (image ? "粘贴图片.png" : "未命名文件"),
    mimeType: file.type || "application/octet-stream",
    data,
  });
}

export function useImageInput(draft: DesktopDraft, disabled: boolean) {
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const active = useRef(true);
  const lock = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const add = async (files: File[]) => {
    if (disabled || lock.current || !files.length) return;
    lock.current = true;
    setReading(true);
    setError("");
    try {
      if (draft.images.length + files.length > MAX_IMAGES)
        throw new Error("每条消息最多添加 4 个附件。");
      await draft.readImages(Promise.all(files.map(readAttachment)));
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      lock.current = false;
      if (active.current) setReading(false);
    }
  };
  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    event.preventDefault();
    void add(files);
  };
  return {
    reading,
    error,
    paste,
    picker: (
      <>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label="选择附件文件"
          disabled={disabled || reading}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void add(files);
          }}
        />
        <button
          type="button"
          className="attach-file"
          aria-label={reading ? "正在读取附件" : "添加附件"}
          aria-busy={reading}
          title="添加附件 · 所有文件类型，单个最大 5 MiB，最多 4 个"
          disabled={disabled || reading}
          onClick={() => input.current?.click()}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path
              d={
                reading
                  ? "M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1M5.6 18.4l2.1-2.1m8.6-8.6 2.1-2.1"
                  : "m8 12 6.8-6.8a3.5 3.5 0 0 1 5 5l-9.2 9.2a5 5 0 0 1-7.1-7.1l9.2-9.2m-5.2 12.7 9.2-9.2"
              }
            />
          </svg>
        </button>
      </>
    ),
  };
}
