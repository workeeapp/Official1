-- Static MOT GTFS (generation-scoped). Queries read status=active only.
-- stop_code is indexed but NOT unique (station + platform rows share codes).

CREATE TABLE "GtfsFeedGenerations" (
    "id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "source_label" VARCHAR(255),
    "feed_start_date" VARCHAR(8),
    "feed_end_date" VARCHAR(8),
    "error_message" TEXT,
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GtfsFeedGenerations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GtfsFeedGenerations_status_idx" ON "GtfsFeedGenerations"("status");

-- At most one active generation.
CREATE UNIQUE INDEX "GtfsFeedGenerations_one_active_idx"
  ON "GtfsFeedGenerations" ("status")
  WHERE "status" = 'active';

CREATE TABLE "GtfsStops" (
    "generation_id" UUID NOT NULL,
    "feed_stop_id" VARCHAR(64) NOT NULL,
    "stop_code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "location_type" INTEGER NOT NULL DEFAULT 0,
    "parent_feed_stop_id" VARCHAR(64),

    CONSTRAINT "GtfsStops_pkey" PRIMARY KEY ("generation_id","feed_stop_id")
);

CREATE INDEX "GtfsStops_generation_id_stop_code_idx" ON "GtfsStops"("generation_id", "stop_code");
CREATE INDEX "GtfsStops_generation_id_location_type_idx" ON "GtfsStops"("generation_id", "location_type");

CREATE TABLE "GtfsAgencies" (
    "generation_id" UUID NOT NULL,
    "agency_id" VARCHAR(32) NOT NULL,
    "name" VARCHAR(255) NOT NULL,

    CONSTRAINT "GtfsAgencies_pkey" PRIMARY KEY ("generation_id","agency_id")
);

CREATE INDEX "GtfsAgencies_generation_id_name_idx" ON "GtfsAgencies"("generation_id", "name");

CREATE TABLE "GtfsRoutes" (
    "generation_id" UUID NOT NULL,
    "feed_route_id" VARCHAR(64) NOT NULL,
    "agency_id" VARCHAR(32) NOT NULL,
    "short_name" VARCHAR(64) NOT NULL,
    "long_name" VARCHAR(255) NOT NULL DEFAULT '',

    CONSTRAINT "GtfsRoutes_pkey" PRIMARY KEY ("generation_id","feed_route_id")
);

CREATE INDEX "GtfsRoutes_generation_id_short_name_idx" ON "GtfsRoutes"("generation_id", "short_name");
CREATE INDEX "GtfsRoutes_generation_id_agency_id_idx" ON "GtfsRoutes"("generation_id", "agency_id");

CREATE TABLE "GtfsRouteNetworks" (
    "id" UUID NOT NULL,
    "generation_id" UUID NOT NULL,
    "feed_route_id" VARCHAR(64) NOT NULL,
    "office_line_id" VARCHAR(64) NOT NULL DEFAULT '',
    "line_id" VARCHAR(64) NOT NULL DEFAULT '',
    "direction" VARCHAR(16) NOT NULL DEFAULT '',
    "agency_id" VARCHAR(32) NOT NULL DEFAULT '',
    "agency_name" VARCHAR(255) NOT NULL DEFAULT '',

    CONSTRAINT "GtfsRouteNetworks_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GtfsRouteNetworks_generation_id_feed_route_id_idx" ON "GtfsRouteNetworks"("generation_id", "feed_route_id");
CREATE INDEX "GtfsRouteNetworks_generation_id_office_line_id_idx" ON "GtfsRouteNetworks"("generation_id", "office_line_id");
CREATE INDEX "GtfsRouteNetworks_generation_id_line_id_direction_idx" ON "GtfsRouteNetworks"("generation_id", "line_id", "direction");

CREATE TABLE "GtfsTrips" (
    "generation_id" UUID NOT NULL,
    "feed_trip_id" VARCHAR(64) NOT NULL,
    "feed_route_id" VARCHAR(64) NOT NULL,
    "service_id" VARCHAR(32) NOT NULL,
    "direction_id" INTEGER,
    "headsign" VARCHAR(255) NOT NULL DEFAULT '',

    CONSTRAINT "GtfsTrips_pkey" PRIMARY KEY ("generation_id","feed_trip_id")
);

CREATE INDEX "GtfsTrips_generation_id_service_id_feed_route_id_direction_id_idx"
  ON "GtfsTrips"("generation_id", "service_id", "feed_route_id", "direction_id");
CREATE INDEX "GtfsTrips_generation_id_feed_route_id_idx" ON "GtfsTrips"("generation_id", "feed_route_id");

CREATE TABLE "GtfsStopTimes" (
    "generation_id" UUID NOT NULL,
    "feed_trip_id" VARCHAR(64) NOT NULL,
    "stop_sequence" INTEGER NOT NULL,
    "feed_stop_id" VARCHAR(64) NOT NULL,
    "arrival_time" VARCHAR(16) NOT NULL DEFAULT '',
    "departure_time" VARCHAR(16) NOT NULL,
    "dep_seconds" INTEGER NOT NULL,

    CONSTRAINT "GtfsStopTimes_pkey" PRIMARY KEY ("generation_id","feed_trip_id","stop_sequence")
);

CREATE INDEX "GtfsStopTimes_generation_id_feed_stop_id_dep_seconds_idx"
  ON "GtfsStopTimes"("generation_id", "feed_stop_id", "dep_seconds");
CREATE INDEX "GtfsStopTimes_generation_id_feed_trip_id_idx"
  ON "GtfsStopTimes"("generation_id", "feed_trip_id");

CREATE TABLE "GtfsCalendarDates" (
    "generation_id" UUID NOT NULL,
    "service_id" VARCHAR(32) NOT NULL,
    "date" VARCHAR(8) NOT NULL,
    "exception_type" INTEGER NOT NULL,

    CONSTRAINT "GtfsCalendarDates_pkey" PRIMARY KEY ("generation_id","service_id","date")
);

CREATE INDEX "GtfsCalendarDates_generation_id_date_idx" ON "GtfsCalendarDates"("generation_id", "date");

ALTER TABLE "GtfsStops" ADD CONSTRAINT "GtfsStops_generation_id_fkey"
  FOREIGN KEY ("generation_id") REFERENCES "GtfsFeedGenerations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GtfsAgencies" ADD CONSTRAINT "GtfsAgencies_generation_id_fkey"
  FOREIGN KEY ("generation_id") REFERENCES "GtfsFeedGenerations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GtfsRoutes" ADD CONSTRAINT "GtfsRoutes_generation_id_fkey"
  FOREIGN KEY ("generation_id") REFERENCES "GtfsFeedGenerations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GtfsRouteNetworks" ADD CONSTRAINT "GtfsRouteNetworks_generation_id_fkey"
  FOREIGN KEY ("generation_id") REFERENCES "GtfsFeedGenerations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GtfsTrips" ADD CONSTRAINT "GtfsTrips_generation_id_fkey"
  FOREIGN KEY ("generation_id") REFERENCES "GtfsFeedGenerations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GtfsStopTimes" ADD CONSTRAINT "GtfsStopTimes_generation_id_fkey"
  FOREIGN KEY ("generation_id") REFERENCES "GtfsFeedGenerations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GtfsCalendarDates" ADD CONSTRAINT "GtfsCalendarDates_generation_id_fkey"
  FOREIGN KEY ("generation_id") REFERENCES "GtfsFeedGenerations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
