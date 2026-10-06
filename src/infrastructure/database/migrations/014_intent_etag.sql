-- The etag captured with an open intent. Mutations send it as If-Match and do not replace it.
ALTER TABLE appointments ADD COLUMN intent_etag TEXT;
