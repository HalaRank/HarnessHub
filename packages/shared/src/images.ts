import { z } from "zod";

export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
export const imageAttachment = z
  .object({
    name: z.string().min(1).max(255),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    data: z
      .string()
      .min(4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((data) => data.length % 4 === 0),
  })
  .strict();
export const fileAttachment = z
  .object({
    kind: z.literal("file"),
    name: z.string().min(1).max(255),
    mimeType: z
      .string()
      .max(255)
      .regex(/^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/),
    data: z
      .string()
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((data) => data.length % 4 === 0),
  })
  .strict();
export type Attachment = z.infer<typeof imageAttachment> | z.infer<typeof fileAttachment>;
// Keep the persisted images field and its public type compatible with existing drafts/events.
export type ImageAttachment = Attachment;
export const attachment = z.union([imageAttachment, fileAttachment]);
export function isImageAttachment(file: Attachment): file is z.infer<typeof imageAttachment> {
  return !("kind" in file);
}
export function attachmentInputError(
  files: Attachment[],
  capabilities: { image?: unknown; embeddedContext?: unknown },
) {
  if (files.some(isImageAttachment) && capabilities.image !== true)
    return "当前 Agent 未声明 ACP 图片输入能力，请选择支持图片的 Harness。";
  if (files.some((file) => !isImageAttachment(file)) && capabilities.embeddedContext !== true)
    return "当前 Agent 未声明 ACP 文件输入能力，请选择支持文件的 Harness。";
  return "";
}
export function imageBytes(image: { data: string }) {
  return (
    (image.data.length * 3) / 4 - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0)
  );
}
export const imageAttachments = z.array(attachment);
export function imageSource(image: ImageAttachment) {
  return `data:${image.mimeType};base64,${image.data}`;
}
export function sameImages(a: ImageAttachment[] = [], b: ImageAttachment[] = []) {
  return (
    a.length === b.length &&
    a.every((image, index) => {
      const other = b[index];
      return (
        image.name === other?.name &&
        image.mimeType === other.mimeType &&
        image.data === other.data &&
        isImageAttachment(image) === isImageAttachment(other)
      );
    })
  );
}
