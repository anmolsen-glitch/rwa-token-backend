/**
 * Image uploads.
 *   public: POST /api/uploads        { dataUrl } -> { url }   (rate-limited)
 *           GET  /api/uploads/:file  serve a stored image
 *
 * Both routes are @Public: a prospective seller uploads before applying, and
 * the images are marketing material, not PII. The POST's larger body limit and
 * stricter rate limit are applied per-route in main.ts.
 */
import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '@shared/auth/decorators';
import { ApiNotFound, ApiValidationError } from '@shared/openapi/api-error.decorator';
import { UploadsService } from './uploads.service';
import { UploadImageDto } from './dto/upload-image.dto';

@ApiTags('Platform')
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @ApiOperation({
    summary: 'Upload an image',
    description:
      'Accepts a base64 image data URL (PNG, JPEG, WebP, or GIF, max 6 MB) and returns ' +
      'the URL it is served from. Public — a prospective seller uploads before applying — ' +
      'but rate-limited well below the global quota.',
  })
  @ApiValidationError()
  @Public()
  @HttpCode(201)
  @Post()
  upload(@Body() dto: UploadImageDto) {
    return this.uploads.save(dto.dataUrl ?? dto.image);
  }

  @ApiOperation({ summary: 'Serve a stored image' })
  @ApiParam({ name: 'file', description: 'Stored filename, as returned by the upload' })
  @ApiNotFound('Image')
  @Public()
  @Get(':file')
  async serve(@Param('file') file: string, @Res() reply: FastifyReply) {
    const { data, mime } = await this.uploads.read(file);
    return reply
      .header('content-type', mime)
      .header('cache-control', 'public, max-age=3600')
      .send(data);
  }
}
