export enum PublicStatusOrder {
    online = 0,
    idle = 1,
    dnd = 2,
    offline = 3,
}

export enum InternalStatusOrder {
    online = 0,
    idle = 1,
    dnd = 2,
    invisible = 3,
    offline = 4,
    unknown = 5,
}

export type PublicStatus = keyof typeof PublicStatusOrder;
export type PrivateStatus = PublicStatus | "invisible";
export type SetPrivateStatus = PrivateStatus | "unknown";

// @deprecated Use PublicStatus, PrivateStatus or SetPrivateStatus instead
export type Status =
    | "idle"
    | "dnd"
    | "online"
    | "offline"
    // Send only
    | "invisible"
    // Identify only
    | "unknown";

export interface ClientStatus {
    desktop?: string; // e.g. Windows/Linux/Mac
    mobile?: string; // e.g. iOS/Android
    web?: string; // e.g. browser, bot account, unknown
    embedded?: string; // e.g. embedded
    vr?: string;
    toaster?: string; // e.g. smart toaster
    terminal?: string; // e.g. terminal
    toilet?: string; // e.g. smart toilet
    bed?: string; // e.g. smart bed
    floor?: string; // e.g. smart floor
    house?: string; // e.g. smart house
    router?: string; // e.g. router
    settings?: string; // e.g. settings page
    smartwatch?: string; // e.g. smartwatch
    clock?: string; // e.g. clock
    leaf?: string; // e.g. smart leaf
    pencil?: string; // e.g. smart pencil
    paper?: string; // e.g. smart paper
    unknown?: string; // e.g. unknown device
}
