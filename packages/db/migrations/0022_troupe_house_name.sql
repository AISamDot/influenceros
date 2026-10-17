-- The product is now Troupe House (formerly Influencer OS). Renames the seeded studio row; a studio the Owner
-- renamed himself is left alone.
UPDATE studio SET name = 'Troupe House Studio' WHERE name = 'Influencer OS Studio';
