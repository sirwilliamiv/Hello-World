-- Rollback for 20260701_create_docs_generation.
--
-- The stored renderings themselves live in data.files and are untouched by this;
-- rolling back loses the template pin that made them reproducible, which is why a
-- rollback in an environment that has issued documents needs a deliberate decision
-- rather than a reflex.

DROP TABLE IF EXISTS docs_generation_document;
DROP TRIGGER IF EXISTS docs_generation_template_version_no_update ON docs_generation_template_version;
DROP FUNCTION IF EXISTS docs_generation_template_version_is_append_only();
DROP TABLE IF EXISTS docs_generation_template_version;
DROP TABLE IF EXISTS docs_generation_template;
