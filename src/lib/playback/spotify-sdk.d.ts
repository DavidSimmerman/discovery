declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: typeof Spotify;
  }

  namespace Spotify {
    type ErrorTypes =
      | 'initialization_error'
      | 'authentication_error'
      | 'account_error'
      | 'playback_error';

    interface Error { message: string }

    interface Track {
      uri: string;
      id: string | null;
      name: string;
      duration_ms: number;
      artists: { uri: string; name: string }[];
      album: {
        uri: string;
        name: string;
        images: { url: string; width?: number; height?: number }[];
      };
    }

    interface PlaybackState {
      paused: boolean;
      position: number;
      duration: number;
      context: { uri: string | null; metadata?: unknown };
      track_window: {
        current_track: Track;
        previous_tracks: Track[];
        next_tracks: Track[];
      };
    }

    interface PlayerInit {
      name: string;
      getOAuthToken: (cb: (token: string) => void) => void;
      volume?: number;
    }

    class Player {
      constructor(init: PlayerInit);
      connect(): Promise<boolean>;
      disconnect(): void;
      addListener(event: 'ready' | 'not_ready', cb: (d: { device_id: string }) => void): boolean;
      addListener(event: 'player_state_changed', cb: (d: PlaybackState | null) => void): boolean;
      addListener(event: ErrorTypes, cb: (d: Error) => void): boolean;
      getCurrentState(): Promise<PlaybackState | null>;
      togglePlay(): Promise<void>;
      previousTrack(): Promise<void>;
      nextTrack(): Promise<void>;
      seek(positionMs: number): Promise<void>;
      setVolume(volume: number): Promise<void>;
      getVolume(): Promise<number>;
      activateElement(): Promise<void>;
    }
  }
}

export {};
