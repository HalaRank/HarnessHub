import {
  IMAGE_ACCEPT,
  type ImageAttachment,
  imageSource,
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
    <section className="image-attachments" aria-label="图片附件">
      {images.map((image, index) => (
        // Previews are stateless, and repeated copies of the same file are supported.
        // biome-ignore lint/suspicious/noArrayIndexKey: each occurrence is removable by position
        <div className="image-attachment" key={`${index}:${image.name}`}>
          <img src={imageSource(image)} alt={image.name} title={image.name} />
          <span className="image-attachment-name" title={image.name}>
            {image.name}
          </span>
          {remove && (
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除图片 ${image.name}`}
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

export async function readImage(file: File): Promise<ImageAttachment> {
  if (!IMAGE_ACCEPT.split(",").includes(file.type))
    throw new Error("支持 PNG、JPEG、GIF 和 WebP 图片。");
  if (!file.size || file.size > MAX_IMAGE_BYTES)
    throw new Error("单张图片须大于 0 且不超过 5 MiB。");
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取图片 ${file.name}`));
    reader.onabort = () => reject(new Error("图片读取已取消。"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
  return {
    name: file.name.slice(0, 255) || "粘贴图片.png",
    mimeType: file.type as ImageAttachment["mimeType"],
    data,
  };
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
        throw new Error("每条消息最多添加 4 张图片。");
      await draft.readImages(Promise.all(files.map(readImage)));
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
          accept={IMAGE_ACCEPT}
          multiple
          hidden
          aria-label="选择图片文件"
          disabled={disabled || reading}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            void add(files);
          }}
        />
        <button
          type="button"
          className="attach-image"
          aria-label="添加图片"
          title="添加图片 · Ctrl+V 粘贴"
          disabled={disabled || reading}
          onClick={() => input.current?.click()}
        >
          {reading ? "读取中…" : "+ 图片"}
        </button>
      </>
    ),
  };
}
