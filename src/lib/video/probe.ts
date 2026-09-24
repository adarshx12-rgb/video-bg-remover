import { ALL_FORMATS, BlobSource, Input } from 'mediabunny';
import { LIMITS } from '../../config';
import { computeOutputSize } from './sizing';

export interface VideoMetadata {
  fileName: string;
  sizeBytes: number;
  durationSeconds: number;
  /** Display dimensions (after rotation metadata is applied). */
  width: number;
  height: number;
  rotation: number;
  output: { width: number; height: number };
  videoCodec: string;
  frameRate: number | null;
  hasAudio: boolean;
  audioCodec: string | null;
  audioDecodable: boolean;
  container: string;
}

export class VideoValidationError extends Error {
  constructor(
    message: string,
    readonly recovery: string,
  ) {
    super(message);
    this.name = 'VideoValidationError';
  }
}

/** Reads container metadata only; no frames are decoded and nothing leaves the device. */
export async function probeVideo(file: File, limits = LIMITS): Promise<VideoMetadata> {
  if (file.size > limits.maxInputBytes) {
    throw new VideoValidationError(
      `This file is ${(file.size / 1024 / 1024).toFixed(0)} MB. The current limit is ${limits.maxInputBytes / 1024 / 1024} MB.`,
      'Trim or compress the video, then select it again.',
    );
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    let container: string;
    try {
      container = (await input.getFormat()).name;
    } catch {
      throw new VideoValidationError(
        'This file type is not supported or the file is damaged.',
        'Use an MP4, MOV or WebM video. If it plays elsewhere, try re-exporting it as MP4 (H.264).',
      );
    }
    const video = await input.getPrimaryVideoTrack();
    if (!video) {
      throw new VideoValidationError('This file has no video track.', 'Select a video file rather than an audio-only file.');
    }
    const codec = video.codec ?? 'unknown';
    if (!(await video.canDecode())) {
      throw new VideoValidationError(
        `This browser cannot decode the video format (${codec}).`,
        'Re-export the video as MP4 (H.264), or try Chrome or Edge.',
      );
    }

    const durationSeconds = await input.computeDuration();
    if (!(durationSeconds > 0)) {
      throw new VideoValidationError('Could not determine the video length.', 'Re-export the video as MP4 (H.264) and try again.');
    }
    if (durationSeconds > limits.maxDurationSeconds + 0.05) {
      throw new VideoValidationError(
        `This video is ${durationSeconds.toFixed(1)} seconds long. The current limit is ${limits.maxDurationSeconds} seconds.`,
        `Trim the video to ${limits.maxDurationSeconds} seconds or less, then select it again.`,
      );
    }

    const width = await video.getDisplayWidth();
    const height = await video.getDisplayHeight();
    const rotation = await video.getRotation();
    let frameRate: number | null = null;
    try {
      const stats = await video.computePacketStats(120);
      frameRate = stats.averagePacketRate > 0 ? stats.averagePacketRate : null;
    } catch {
      /* frame rate is informational only */
    }

    const audio = await input.getPrimaryAudioTrack();
    const audioDecodable = audio ? await audio.canDecode() : false;

    return {
      fileName: file.name,
      sizeBytes: file.size,
      durationSeconds,
      width,
      height,
      rotation,
      output: computeOutputSize(width, height, limits.maxOutputDimension),
      videoCodec: codec,
      frameRate,
      hasAudio: !!audio,
      audioCodec: audio?.codec ?? null,
      audioDecodable,
      container,
    };
  } finally {
    input.dispose();
  }
}
