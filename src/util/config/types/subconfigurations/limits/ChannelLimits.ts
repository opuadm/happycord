export class ChannelLimits {
    allowSlowmodeBypass: boolean = false;
    maxPins: number = 500;
    maxTopic: number = 1024;
    maxWebhooks: number = 100;
    maxName: number = 100;
    maxGroupDmRecipients: number = 25; // everyone in a group DM, its owner included
    maxStaffGroupDmRecipients: number = 100;
}
