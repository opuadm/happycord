/* SPDX-License-Identifier: AGPL-3.0-only */
import { BaseEntity, Column, Entity, Index, PrimaryColumn } from "typeorm";

@Entity({ name: "federation_state" })
export class FederationState extends BaseEntity {
    @PrimaryColumn({ type: "varchar" }) id: string;
    @Column({ type: "text", nullable: true }) document: string | null;
    @Column({ type: "varchar", nullable: true }) signature: string | null;
    @Column({ type: "varchar", nullable: true }) key_id: string | null;
    @Column({ type: "int8", nullable: true }) sequence: string | null;
    @Column({ type: "timestamptz", nullable: true }) issued_at: Date | null;
    @Column({ type: "timestamptz", nullable: true }) expires_at: Date | null;
    @Column({ type: "timestamptz", nullable: true }) accepted_at: Date | null;
    @Column({ type: "timestamptz", nullable: true }) last_fetch_at: Date | null;
    @Column({ type: "text", nullable: true }) last_error: string | null;
    @Column({ type: "timestamptz", nullable: true }) announced_at: Date | null;
    @Column({ type: "varchar", nullable: true }) announce_status: string | null;
    @Column({ type: "text", nullable: true }) announce_error: string | null;
}

@Entity({ name: "federation_peers" })
export class FederationPeer extends BaseEntity {
    @PrimaryColumn({ type: "varchar" }) id: string;
    @Column({ type: "varchar", nullable: true }) public_key: string | null;
    @Column({ type: "text", nullable: true }) well_known: string | null;
    @Column({ type: "text", nullable: true }) discovery: string | null;
    @Column({ type: "timestamptz", nullable: true }) fetched_at: Date | null;
    @Column({ type: "text", nullable: true }) error: string | null;
}

export type FederationBlockKind = "instance" | "guild" | "user";

@Entity({ name: "federation_blocks" })
@Index("IDX_federation_blocks_target", ["kind", "target"], { unique: true })
export class FederationBlock extends BaseEntity {
    @PrimaryColumn({ type: "int8" }) id: string;
    @Column({ type: "varchar" }) kind: FederationBlockKind;
    @Column({ type: "varchar" }) target: string;
    @Column({ type: "text", default: "" }) reason: string;
    @Column({ type: "timestamptz" }) created_at: Date;
    @Column({ type: "int8", nullable: true }) created_by: string | null;
}

@Entity({ name: "federated_objects" })
export class FederatedObject extends BaseEntity {
    @PrimaryColumn({ type: "varchar" }) canonical: string;
    @Index("IDX_federated_objects_local_id", { unique: true }) @Column({ type: "varchar" }) local_id: string;
    @Index("IDX_federated_objects_instance") @Column({ type: "varchar" }) instance: string;
    @Index("IDX_federated_objects_created_at") @Column({ type: "timestamptz" }) created_at: Date;
}

@Entity({ name: "federation_deliveries" })
export class FederationDelivery extends BaseEntity {
    @PrimaryColumn({ type: "varchar" }) instance: string;
    @Column({ type: "int", default: 0 }) queued: number;
    @Column({ type: "int8", default: 0 }) delivered: string;
    @Column({ type: "int8", default: 0 }) dropped: string;
    @Column({ type: "timestamptz", nullable: true }) last_attempt_at: Date | null;
    @Column({ type: "timestamptz", nullable: true }) last_success_at: Date | null;
    @Column({ type: "text", nullable: true }) last_error: string | null;
    @Column({ type: "timestamptz", nullable: true }) failing_since: Date | null;
    @Column({ type: "timestamptz", nullable: true }) unreachable_at: Date | null;
}

@Entity({ name: "federation_outbox" })
@Index("IDX_federation_outbox_instance_id", ["instance", "id"])
export class FederationOutboxEvent extends BaseEntity {
    @PrimaryColumn({ type: "int8" }) id: string;
    @Column({ type: "varchar" }) instance: string;
    @Column({ type: "text" }) wire: string;
    @Column({ type: "timestamptz" }) created_at: Date;
}

@Entity({ name: "federation_inbox_events" })
export class FederationInboxEvent extends BaseEntity {
    @PrimaryColumn({ type: "varchar" }) sender: string;
    @PrimaryColumn({ type: "varchar" }) event_id: string;
    @Index("IDX_federation_inbox_events_received_at") @Column({ type: "timestamptz" }) received_at: Date;
}

@Entity({ name: "federation_verified_guilds" })
export class FederationVerifiedGuild extends BaseEntity {
    @PrimaryColumn({ type: "varchar" }) id: string;
    @Column({ type: "varchar" }) instance: string;
    @Column({ type: "timestamptz" }) verified_at: Date;
    @Column({ type: "int8", nullable: true }) verified_by: string | null;
}

@Entity({ name: "federated_e2ee_keys" })
export class FederatedE2eeKeys extends BaseEntity {
    @PrimaryColumn({ type: "varchar" }) user_id: string;
    @Index("IDX_federated_e2ee_keys_instance") @Column({ type: "varchar" }) instance: string;
    @Column({ type: "text" }) keys: string;
    @Column({ type: "timestamptz" }) fetched_at: Date;
}

export type FederationMoveStatus = "pending" | "running" | "applied" | "unverified" | "refused";

@Entity({ name: "federation_moves" })
@Index("IDX_federation_moves_route", ["from_id", "to_id", "at"], { unique: true })
export class FederationMove extends BaseEntity {
    @PrimaryColumn({ type: "int8" }) id: string;
    @Index("IDX_federation_moves_from_id") @Column({ type: "varchar" }) from_id: string;
    @Index("IDX_federation_moves_to_id") @Column({ type: "varchar" }) to_id: string;
    @Column({ type: "timestamptz" }) at: Date;
    @Column({ type: "varchar" }) source: string;
    @Column({ type: "varchar" }) status: FederationMoveStatus;
    @Column({ type: "text", nullable: true }) detail: string | null;
    @Column({ type: "text", nullable: true }) proof: string | null;
    @Column({ type: "varchar", nullable: true }) proof_kind: string | null;
    @Column({ type: "varchar", nullable: true }) previous_key: string | null;
    @Column({ type: "varchar", nullable: true }) public_key: string | null;
    @Column({ type: "text", nullable: true }) counts: string | null;
    @Column({ type: "timestamptz" }) created_at: Date;
    @Column({ type: "timestamptz", nullable: true }) applied_at: Date | null;
}

@Entity({ name: "federation_instance_keys" })
export class FederationInstanceKey extends BaseEntity {
    @PrimaryColumn({ type: "varchar" }) instance: string;
    @Column({ type: "varchar" }) public_key: string;
    @Column({ type: "varchar" }) source: string;
    @Column({ type: "timestamptz" }) seen_at: Date;
}
