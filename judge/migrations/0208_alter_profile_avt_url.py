# Generated by Django 3.2.25 on 2024-07-27 09:14

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('judge', '0207_alter_profile_avt_url'),
    ]

    operations = [
        migrations.AlterField(
            model_name='profile',
            name='avt_url',
            field=models.FileField(default='', upload_to=''),
        ),
    ]
