export interface CreateReportSchema {
    version: string;
    variant: string;
    name: string;
    language: string;
    breadcrumbs: number[];
    elements?: { [key: string]: string[] | string };
    channel_id?: string; // snowflake
    message_id?: string; // snowflake
    guild_id?: string; // snowflake
    stage_instance_id?: string; // snowflake
    guild_scheduled_event_id?: string; // snowflake
    reported_user_id?: string; // snowflake
    entrypoint?: string;
    application_id?: string; // snowflake
    user_id?: string; // snowflake
    widget_id?: string; // snowflake
    e2ee_content_key?: string;
    e2ee_context_keys?: { [message_id: string]: string };
}

export interface CreateReportResponse {
    report_id: string;
    id: string;
}
