import { VideoValidationError } from '../../lib/video/probe';

export interface FriendlyError {
  title: string;
  message: string;
  recovery: string;
}

type Context = 'file' | 'model' | 'process' | 'preview';

/** Turn any thrown value into a message that says what happened and what to do next. */
export function toFriendlyError(error: unknown, context: Context): FriendlyError {
  if (error instanceof VideoValidationError) {
    return { title: "This video can't be used", message: error.message, recovery: error.recovery };
  }
  const text = error instanceof Error ? error.message : String(error);

  if (/ran out of memory/i.test(text)) {
    return { title: 'Not enough memory', message: text, recovery: 'Close other tabs, then try a shorter video or a lower frame rate.' };
  }
  if (/internet connection|download failed|Failed to fetch|NetworkError|HTTP \d{3}/i.test(text)) {
    return {
      title: 'The model could not be downloaded',
      message: text,
      recovery: 'Check your internet connection, then select Try again. Model files are only downloaded once.',
    };
  }
  if (/quota|QuotaExceeded/i.test(text)) {
    return {
      title: 'Not enough storage for the model',
      message: 'The browser refused to store the model files.',
      recovery: 'Free up disk space or clear this site’s stored data, then try again.',
    };
  }
  if (/graphics device was reset|device lost/i.test(text)) {
    return { title: 'The graphics chip was reset', message: text, recovery: 'Select Try again. If it happens again, restart the browser.' };
  }
  if (/worker crashed/i.test(text)) {
    return { title: 'Processing stopped unexpectedly', message: text, recovery: 'Select Try again. A shorter video or lower frame rate uses less memory.' };
  }

  switch (context) {
    case 'file':
      return { title: "This video can't be opened", message: text, recovery: 'Try an MP4 (H.264), MOV or WebM file.' };
    case 'model':
      return { title: 'The model could not start', message: text, recovery: 'Select Try again, or choose the other model.' };
    case 'preview':
      return { title: 'The preview could not be made', message: text, recovery: 'Move to a different moment in the video and try again.' };
    default:
      return {
        title: 'The video could not be processed',
        message: text,
        recovery: 'Select Try again. If it fails again, try another download format or a lower frame rate.',
      };
  }
}
