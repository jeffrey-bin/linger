// Normalize uploaded photos to small, static images before saving the profile.
export async function prepareProfileImage(
  file: File,
  avatar: boolean,
): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("Choose a JPG, PNG, or WebP image.");
  }
  if (file.size > 5 * 1024 * 1024)
    throw new Error("Choose an image smaller than 5 MB.");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const ratio = Math.min(
      1,
      (avatar ? 512 : 1600) / Math.max(bitmap.width, bitmap.height),
    );
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser could not read this image.");
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.85, 0.7, 0.5]) {
      const image = canvas.toDataURL("image/jpeg", quality);
      if (image.length <= 524288) return image;
    }
    throw new Error("This image is too detailed. Choose a smaller image.");
  } finally {
    bitmap.close();
  }
}
