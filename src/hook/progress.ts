export interface ReviewProgressEvent {
  step: string;
  message: string;
  provider?: string;
  model?: string;
  detail?: string;
}

export type ReviewProgress = (event: ReviewProgressEvent) => void;
