declare global {
  namespace App {
    interface Locals {
      user: { id: string; spotifyId: string; displayName: string | null } | null;
    }
  }
}

export {};
