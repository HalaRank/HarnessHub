import { z } from "zod";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 4;
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
export const imageAttachment = z
  .object({
    name: z.string().min(1).max(255),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    data: z
      .string()
      .min(4)
      .max(4 * Math.ceil(MAX_IMAGE_BYTES / 3))
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .refine((data) => data.length % 4 === 0),
  })
  .strict()
  .refine((image) => imageBytes(image) <= MAX_IMAGE_BYTES, "单张图片不能超过 5 MiB");
export type ImageAttachment = z.infer<typeof imageAttachment>;
export function imageBytes(image: { data: string }) {
  return (
    (image.data.length * 3) / 4 - (image.data.endsWith("==") ? 2 : image.data.endsWith("=") ? 1 : 0)
  );
}
export const imageAttachments = z
  .array(imageAttachment)
  .max(MAX_IMAGES, "每条消息最多添加 4 张图片")
  .refine(
    (images) => images.reduce((sum, image) => sum + imageBytes(image), 0) <= MAX_IMAGES_BYTES,
    "图片合计不能超过 10 MiB",
  );
export function imageSource(image: ImageAttachment) {
  return `data:${image.mimeType};base64,${image.data}`;
}
export function sameImages(a: ImageAttachment[] = [], b: ImageAttachment[] = []) {
  return (
    a.length === b.length &&
    a.every((image, index) => {
      const other = b[index];
      return (
        image.name === other?.name && image.mimeType === other.mimeType && image.data === other.data
      );
    })
  );
}
