-- +goose Up
-- Wiki pages keep only their newest Versions. The retention sweep may delete a
-- Version, and clear the base of the oldest Version it keeps, when its
-- transaction sets teamhub.document_retention=on; Versions stay immutable
-- otherwise.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.protect_document_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    expected_version_number integer;
BEGIN
    IF TG_OP='INSERT' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.document_id,0));
        SELECT coalesce(max(version_number),0)+1 INTO expected_version_number
        FROM document_versions
        WHERE document_id=NEW.document_id;
        IF NEW.version_number<>expected_version_number THEN
            RAISE EXCEPTION 'Document Version number is not contiguous';
        END IF;
        RETURN NEW;
    END IF;
    IF current_setting('teamhub.document_retention',true)='on' THEN
        IF TG_OP='DELETE' THEN
            RETURN OLD;
        END IF;
        IF NEW.base_version_id IS NULL
           AND to_jsonb(NEW)-'base_version_id'=to_jsonb(OLD)-'base_version_id' THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'Document Version is immutable after insertion';
END $$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.protect_document_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    expected_version_number integer;
BEGIN
    IF TG_OP='INSERT' THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(NEW.document_id,0));
        SELECT coalesce(max(version_number),0)+1 INTO expected_version_number
        FROM document_versions
        WHERE document_id=NEW.document_id;
        IF NEW.version_number<>expected_version_number THEN
            RAISE EXCEPTION 'Document Version number is not contiguous';
        END IF;
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Document Version is immutable after insertion';
END $$;
-- +goose StatementEnd
