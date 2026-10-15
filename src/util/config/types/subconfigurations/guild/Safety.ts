export class SafetyConfiguration {
    harmfulLinkDomains: string[] = [];
    raidJoinThreshold: number = 15;
    raidJoinWindowSeconds: number = 120;
    raidNewAccountJoinThreshold: number = 8;
    raidNewAccountHours: number = 24;
    raidInviteJoinThreshold: number = 10;
    raidPauseInvitesMinutes: number = 60;
    dmRaidThreshold: number = 10;
    dmRaidWindowSeconds: number = 300;
    dmRaidPauseDmsMinutes: number = 60;
    mentionRaidThreshold: number = 3;
    mentionRaidWindowSeconds: number = 300;
}
