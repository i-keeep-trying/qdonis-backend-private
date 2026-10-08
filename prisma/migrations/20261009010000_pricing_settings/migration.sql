-- Pricing settings the web app reads to estimate token costs.
INSERT INTO "app_settings" ("key", "value", "updated_at") VALUES
  ('token_pricing', '{"markupMultiplier":1,"displayAsCredits":false,"creditsPerToken":1}', CURRENT_TIMESTAMP),
  ('step_multipliers', '{"multipliers":{"initial_requirements":1,"project_name_generation":1,"stage_parameters_analysis":1,"mandatory_parameters":1,"topology_generation":1,"circuit_schematic_generation":1,"component_sourcing":1,"magnetics_extraction":1,"magnetics_design":1,"component_evaluation":1}}', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
