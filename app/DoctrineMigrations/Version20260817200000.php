<?php

namespace Application\Migrations;

use Doctrine\DBAL\Schema\Schema;
use Wallabag\CoreBundle\Doctrine\WallabagMigration;

/**
 * Added the internal settings for the read-along TTS reader.
 *
 * default_internal_settings in app/config/wallabag.yml only seeds a *fresh*
 * install (InstallCommand::setupConfig deletes and re-inserts), so without this
 * migration an existing instance would have no rows and craue_setting() would
 * throw when the entry template asks whether TTS is enabled.
 *
 * Note the table is internal_setting, not craue_config_setting: it was renamed
 * in Version20200428072628. Older migrations still reference the old name, so
 * copying one of those as a template produces a migration that fails on any
 * install newer than 2020.
 */
class Version20260817200000 extends WallabagMigration
{
    public function up(Schema $schema): void
    {
        $connection = $this->container
            ->get('doctrine.orm.default_entity_manager')
            ->getConnection();

        $existing = $connection->fetchOne(
            'SELECT * FROM ' . $this->getTable('internal_setting') . " WHERE name = 'tts_enabled'"
        );

        $this->skipIf(false !== $existing, 'It seems that you already played this migration.');

        // Ships disabled: the reader needs the companion service deployed and
        // reachable, so enabling it by default would put a dead player on every
        // article of an instance that has no TTS backend.
        $this->addSql('INSERT INTO ' . $this->getTable('internal_setting') . " (name, value, section) VALUES ('tts_enabled', 0, 'entry')");
        $this->addSql('INSERT INTO ' . $this->getTable('internal_setting') . " (name, value, section) VALUES ('tts_base_path', '/tts', 'entry')");
    }

    public function down(Schema $schema): void
    {
        $this->addSql('DELETE FROM ' . $this->getTable('internal_setting') . " WHERE name = 'tts_enabled';");
        $this->addSql('DELETE FROM ' . $this->getTable('internal_setting') . " WHERE name = 'tts_base_path';");
    }
}
