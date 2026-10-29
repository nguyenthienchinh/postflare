-- Image thumbnails (one small WebP per image, made with the Images binding when the upload completes), stored in R2 at
-- <media id>/thumb/480.webp. 1 = it exists (the media DTO's thumbUrl), 0 = none (videos, older images, failed transforms).
ALTER TABLE media ADD COLUMN has_thumb INTEGER NOT NULL DEFAULT 0;
