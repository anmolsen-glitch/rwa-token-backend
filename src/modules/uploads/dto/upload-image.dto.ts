import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/* `image` is the legacy field name the admin portal still sends; `dataUrl` is
   the documented one. The service takes whichever is present. Content checks
   (data-URL shape, MIME, size) live in the service because they produce
   specific codes (415, 413) the pipe cannot express. */
export const UploadImageSchema = z.object({
  dataUrl: z.string().optional(),
  image: z.string().optional(),
});

export class UploadImageDto extends createZodDto(UploadImageSchema) {}
