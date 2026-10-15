import { Column, Entity, JoinColumn, ManyToOne } from "typeorm";
import { BaseClass } from "./BaseClass";
import { User } from "./User";
import { Channel } from "./Channel";

@Entity({
    name: "cloud_attachments",
})
export class CloudAttachment extends BaseClass {
    // Internal tracking metadata
    @Column({ name: "user_id", nullable: true })
    userId: string;

    @JoinColumn({ name: "user_id", foreignKeyConstraintName: "FK_cloud_attachment_user_id" })
    @ManyToOne(() => User, { nullable: true, onDelete: "SET NULL" })
    user?: User;

    @Column({ name: "channel_id", nullable: true })
    channelId?: string; // channel the file is uploaded to

    @JoinColumn({ name: "channel_id", foreignKeyConstraintName: "FK_cloud_attachment_channel_id" })
    @ManyToOne(() => Channel, { nullable: true, onDelete: "SET NULL" })
    channel?: Channel; // channel the file is uploaded to

    @Column({ name: "upload_filename" })
    uploadFilename: string;

    // User-provided info
    @Column({ name: "user_attachment_id", nullable: true })
    userAttachmentId?: string;

    @Column({ name: "user_filename" })
    userFilename: string; // name of file attached

    @Column({ name: "user_file_size", nullable: true })
    userFileSize?: number; // size of file in bytes

    @Column({ name: "user_original_content_type", nullable: true })
    userOriginalContentType?: string;

    @Column({ name: "user_is_clip", nullable: true })
    userIsClip?: boolean; // whether the file is a clip

    // Actual file info, initialised after upload
    @Column({ nullable: true })
    size?: number; // size of file in bytes

    @Column({ nullable: true })
    height?: number; // height of file (if image)

    @Column({ nullable: true })
    width?: number; // width of file (if image)

    @Column({ name: "content_type", nullable: true })
    contentType?: string;

    @Column({ name: "content_hash", type: "varchar", nullable: true })
    contentHash?: string | null;

    // @BeforeRemove()
    // onDelete() {
    // 	return deleteFile(new URL(this.url).pathname);
    // }
}
